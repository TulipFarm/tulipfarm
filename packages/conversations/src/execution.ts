import { z } from 'zod';
import {
  AccessDenied,
  lockAuthorization,
  resolveHuman,
  uuidSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  cancelJob,
  ensureArea,
  executionScope,
  ExecutionConflict,
  findArea,
  grantConsent,
  hasConsent,
  enqueueJob,
  jobRequestSchema,
  readJob,
  readOutput,
  appendOutput,
  executionJobReference,
  revokeConsent,
  manifestFiles,
  manifestFile,
  readObject,
  readExecutionObject,
  type ExecutionObjectBytes,
  type ExecutionArea,
  type ExecutionScope,
  type ExecutionIntent,
} from '@tulipfarm/execution';
import {
  executionPathSchema,
  executionFileSchema,
  executionOutputSchema,
  executionOutputBytes,
  executionOutputChunkBytes,
  type ExecutionOutput,
  type ExecutionBackend,
  type ExecutionConfiguration,
  type ExecutionDescriptor,
} from '@tulipfarm/execution-contract';
import { chatAccess, type ChatAccessRule } from './chat-access.ts';
import {
  requireConversationMcpSources,
  requireCurrentConversationSources,
  requireResultSources,
} from './source-access.ts';
import { sourceDependenciesSchema } from './results.ts';
import type { ConversationRuntime } from './runtime.ts';

const consentSchema = z.strictObject({ scopeRevision: z.string().regex(/^[a-f0-9]{64}$/), profileId: z.string() });
const workSchema = jobRequestSchema.extend({ sources: sourceDependenciesSchema });
export const chatExecutionVersion = 56;

export const executionDownloadSchema = z.strictObject({ manifestId: uuidSchema, path: executionPathSchema });
export const executionFilesSchema = z.strictObject({
  manifestId: uuidSchema.nullable(),
  files: z.array(executionFileSchema).max(100),
  after: executionPathSchema.nullable(),
});
export { ExecutionConflict };
const publicJob = (job: Awaited<ReturnType<typeof readJob>>) => ({
  id: job.id,
  state: job.state,
  cancelRequested: job.cancel_requested_at !== null,
  queueDeadline: job.queue_deadline.toISOString(),
  deadline: job.deadline?.toISOString() ?? null,
  fileSave: job.file_save,
  output: { after: job.output_cursor, complete: job.output_complete, truncated: job.output_truncated },
});

async function requireExecutionTurn(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  conversationId: string,
  request: Pick<z.infer<typeof jobRequestSchema>, 'turnId' | 'turnGeneration' | 'turnEpoch' | 'callId'>,
) {
  const turn = await tx.client.query(
    `SELECT 1 FROM ${qualified(tx.schema, 'tf_conversation_turns')} t
      JOIN ${qualified(tx.schema, 'tf_conversation_messages')} m ON m.id=t.source_message_id
      JOIN ${qualified(tx.schema, 'tf_conversation_tool_calls')} c ON c.turn_id=t.id AND c.conversation_id=t.conversation_id
      WHERE t.id=$1 AND t.conversation_id=$2 AND t.generation=$3 AND t.attempt_epoch=$4
        AND m.membership_id=$5 AND c.id=$6 AND c.status='running'
        AND (t.status='waiting' OR (t.status='processing' AND t.lease_until>clock_timestamp()))`,
    [request.turnId, conversationId, request.turnGeneration, request.turnEpoch, actor.membershipId, request.callId],
  );
  if (!turn.rowCount) throw new ExecutionConflict('stale');
  await requireCurrentConversationSources(tx, conversationId, request.turnId);
}

/** Only the server supplies userId; agent calls enter through a currently fenced chat turn. */
export function createChatExecution(
  runtime: ConversationRuntime,
  configuration: ExecutionConfiguration,
  descriptor?: ExecutionDescriptor,
  objects?: ExecutionObjectBytes,
) {
  async function transaction<T>(
    workspaceId: string,
    userId: string,
    conversationId: string,
    rule: ChatAccessRule,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    uuidSchema.parse(conversationId);
    return runtime.transaction(
      uuidSchema.parse(workspaceId),
      { ...commonCompatibility, minimum: chatExecutionVersion },
      async tx => {
        await lockAuthorization(tx);
        const actor = await resolveHuman(tx, userId);
        await chatAccess(tx, actor, conversationId, rule, true);
        await requireConversationMcpSources(tx, actor, conversationId);
        return operation(tx, actor);
      },
    );
  }
  function scope(profileId?: string): ExecutionScope {
    if (!descriptor) throw new ExecutionConflict('disabled');
    return executionScope(configuration, descriptor, profileId);
  }
  async function ownedArea(tx: AuthorizationTransaction, conversationId: string): Promise<ExecutionArea> {
    const area = await findArea(tx, conversationId);
    if (!area || area.state !== 'active') throw new AccessDenied();
    return area;
  }
  async function status(workspaceId: string, userId: string, conversationId: string, profileId?: string) {
    return transaction(workspaceId, userId, conversationId, 'read', async tx => {
      const area = await findArea(tx, conversationId);
      if (configuration.mode === 'off' || !descriptor) return { enabled: false as const };
      const selected = profileId ?? area?.profile.id;
      const allowed = configuration.policy.profiles.some(profile => profile.id === selected) ? selected : undefined;
      const current = scope(allowed);
      return {
        enabled: true as const,
        profile: current.profile,
        profiles: configuration.policy.profiles,
        scopeRevision: current.scopeRevision,
        capabilities: descriptor.capabilities,
        consentRequired: !area || !(await hasConsent(tx, area, current)),
      };
    });
  }
  async function grant(workspaceId: string, userId: string, conversationId: string, value: unknown) {
    const input = consentSchema.parse(value);
    return transaction(workspaceId, userId, conversationId, 'turn', async (tx, actor) => {
      const current = scope(input.profileId);
      if (input.scopeRevision !== current.scopeRevision) throw new ExecutionConflict('stale');
      const area = await ensureArea(tx, conversationId, current);
      const updated = await grantConsent(tx, area, actor.membershipId, current);
      return { consentRevision: updated.consent_revision, scopeRevision: updated.scope_revision };
    });
  }
  async function revoke(workspaceId: string, userId: string, conversationId: string) {
    return transaction(workspaceId, userId, conversationId, 'turn', async tx => {
      await revokeConsent(tx, await ownedArea(tx, conversationId));
    });
  }
  async function enqueue(workspaceId: string, userId: string, conversationId: string, value: unknown) {
    const { sources, ...request } = workSchema.parse(value);
    return transaction(workspaceId, userId, conversationId, 'turn', async (tx, actor) => {
      if (configuration.mode === 'off') throw new ExecutionConflict('disabled');
      const area = await ownedArea(tx, conversationId);
      if (!(await hasConsent(tx, area, scope(area.profile.id)))) throw new ExecutionConflict('consent-required');
      await requireExecutionTurn(tx, actor, conversationId, request);
      await requireResultSources(tx, actor, conversationId, sources);
      return publicJob(await enqueueJob(tx, area, actor.membershipId, request, sources, configuration.policy));
    });
  }
  async function job(workspaceId: string, userId: string, conversationId: string, jobId: string) {
    return transaction(workspaceId, userId, conversationId, 'read', async (tx, actor) => {
      const area = await ownedArea(tx, conversationId);
      const record = await readJob(tx, area.id, jobId);
      await requireResultSources(tx, actor, conversationId, record.sources);
      return publicJob(record);
    });
  }
  async function stop(workspaceId: string, userId: string, conversationId: string, jobId: string) {
    return transaction(workspaceId, userId, conversationId, 'turn', async tx => {
      const area = await ownedArea(tx, conversationId);
      return publicJob(await cancelJob(tx, area, await readJob(tx, area.id, jobId)));
    });
  }
  async function output(workspaceId: string, userId: string, conversationId: string, jobId: string, after: number = 0) {
    return transaction(workspaceId, userId, conversationId, 'read', async (tx, actor) => {
      const area = await ownedArea(tx, conversationId);
      const job = await readJob(tx, area.id, jobId);
      await requireResultSources(tx, actor, conversationId, job.sources);
      const events = await readOutput(tx, job, after, 64);
      const cursor = events.at(-1)?.sequence ?? after;
      return { events, after: cursor, complete: job.output_complete && cursor === job.output_cursor };
    });
  }
  async function captureOutput(
    workspaceId: string,
    userId: string,
    conversationId: string,
    operation: { intent: ExecutionIntent; runnerId: string; backend: ExecutionBackend; signal: AbortSignal },
  ) {
    const { intent, backend, signal } = operation;
    const runnerId = uuidSchema.parse(operation.runnerId);
    if (configuration.mode === 'off') throw new ExecutionConflict('disabled');
    if (!intent.job_id || !['start', 'poll'].includes(intent.operation)) throw new ExecutionConflict('stale');
    const jobId = intent.job_id;
    const limits = configuration.policy.limits;
    async function authorize(tx: AuthorizationTransaction, actor: HumanActor) {
      signal.throwIfAborted();
      const area = await ownedArea(tx, conversationId);
      const job = await readJob(tx, area.id, jobId);
      if (
        area.id !== intent.area_id ||
        area.generation !== intent.generation ||
        job.generation !== area.generation ||
        job.membership_id !== actor.membershipId
      )
        throw new ExecutionConflict('stale');
      if (
        job.consent_revision !== area.consent_revision ||
        !(await hasConsent(tx, area, executionScope(configuration, backend.descriptor, area.profile.id)))
      )
        throw new ExecutionConflict('consent-required');
      await requireExecutionTurn(tx, actor, conversationId, {
        turnId: job.turn_id,
        turnGeneration: job.turn_generation,
        turnEpoch: job.turn_epoch,
        callId: job.call_id,
      });
      await requireResultSources(tx, actor, conversationId, job.sources);
      const claim = await tx.client.query(
        `SELECT 1 FROM ${qualified(tx.schema, 'tf_execution_outbox')} o
          JOIN ${qualified(tx.schema, 'tf_execution_allocations')} a
            ON a.area_id=o.area_id AND a.generation=o.generation
          WHERE o.id=$1 AND o.lease_id=$2 AND o.lease_until>clock_timestamp() AND o.completed_at IS NULL
            AND o.area_id=$3 AND o.generation=$4 AND o.job_id=$5 AND o.operation=$6
            AND a.id=$7 AND a.runner_id=$8 AND a.state<>'stopped'
          FOR UPDATE OF o,a`,
        [intent.id, intent.lease_id, area.id, area.generation, job.id, intent.operation, job.allocation_id, runnerId],
      );
      if (!claim.rowCount) throw new ExecutionConflict('stale');
      signal.throwIfAborted();
      return { area, job };
    }
    const initial = await transaction(workspaceId, userId, conversationId, 'turn', authorize);
    if (initial.job.output_complete)
      return {
        after: initial.job.output_cursor,
        bytes: initial.job.output_bytes,
        truncated: initial.job.output_truncated,
        complete: true,
      };
    const maximumBytes = Math.min(limits.outputBytes, 64 * executionOutputChunkBytes);
    const events: ExecutionOutput[] = [];
    let bytes = 0;
    for await (const value of backend.readOutput(
      { ...executionJobReference(initial.job), after: initial.job.output_cursor, maximumBytes },
      { signal },
    )) {
      signal.throwIfAborted();
      const event = executionOutputSchema.parse(value);
      bytes += executionOutputBytes(event);
      if (bytes > maximumBytes) throw new ExecutionConflict('quota');
      events.push(event);
      if (events.length === 64) break;
    }
    return transaction(workspaceId, userId, conversationId, 'turn', async (tx, actor) => {
      const { area, job } = await authorize(tx, actor);
      if (job.allocation_id !== initial.job.allocation_id) throw new ExecutionConflict('stale');
      const saved = await appendOutput(tx, area, job.id, events, limits);
      signal.throwIfAborted();
      return { after: saved.cursor, bytes: saved.bytes, truncated: saved.truncated, complete: saved.complete };
    });
  }
  async function files(workspaceId: string, userId: string, conversationId: string, after: string | null = null) {
    return transaction(workspaceId, userId, conversationId, 'read', async (tx, actor) => {
      const area = await ownedArea(tx, conversationId);
      const entries = await manifestFiles(tx, area, after, 100);
      for (const entry of entries) await requireResultSources(tx, actor, conversationId, entry.sources);
      return {
        manifestId: area.manifest_id,
        files: entries.map(({ path, size, sha256, executable }) => ({ path, size, sha256, executable })),
        after: entries.length === 100 ? entries.at(-1)!.path : null,
      };
    });
  }
  async function download(
    workspaceId: string,
    userId: string,
    conversationId: string,
    value: unknown,
    signal: AbortSignal,
  ) {
    const input = executionDownloadSchema.parse(value);
    if (!objects) throw new ExecutionConflict('disabled');
    async function authorize() {
      signal.throwIfAborted();
      return transaction(workspaceId, userId, conversationId, 'read', async (tx, actor) => {
        const area = await ownedArea(tx, conversationId);
        if (area.manifest_id !== input.manifestId) throw new ExecutionConflict('stale');
        const file = await manifestFile(tx, area, input.path);
        await requireResultSources(tx, actor, conversationId, file.sources);
        const object = await readObject(tx, area.id, file.objectId);
        if (object.state !== 'ready' || object.size !== file.size || object.sha256 !== file.sha256)
          throw new ExecutionConflict('stale');
        return { area, file, object };
      });
    }
    const { area, file, object } = await authorize();
    return {
      file: { path: file.path, size: file.size, sha256: file.sha256, executable: file.executable },
      bytes: readExecutionObject(
        objects,
        { workspaceId, areaId: area.id, objectId: object.id, size: file.size, sha256: file.sha256 },
        object.chunks,
        async () => {
          await authorize();
        },
        signal,
      ),
    };
  }
  return { status, grant, revoke, enqueue, job, stop, output, captureOutput, files, download };
}

export async function hasExecutionWork(tx: AuthorizationTransaction, conversationId: string, turnId: string) {
  return !!(
    await tx.client.query(
      `SELECT 1 FROM ${qualified(tx.schema, 'tf_execution_jobs')} WHERE conversation_id=$1 AND turn_id=$2
      AND state NOT IN ('completed','cancelled','timed-out') LIMIT 1`,
      [conversationId, turnId],
    )
  ).rowCount;
}

export async function cancelExecutionTurn(tx: AuthorizationTransaction, conversationId: string, turnId: string) {
  const area = await findArea(tx, conversationId);
  if (!area) return;
  const jobs = await tx.client.query(
    `SELECT id FROM ${qualified(tx.schema, 'tf_execution_jobs')} WHERE area_id=$1 AND turn_id=$2
      AND state NOT IN ('completed','cancelled','timed-out') ORDER BY id FOR UPDATE`,
    [area.id, turnId],
  );
  for (const row of jobs.rows) {
    const id = z.object({ id: uuidSchema }).parse(row).id;
    await cancelJob(tx, area, await readJob(tx, area.id, id));
  }
}

export async function deleteChatExecution(tx: AuthorizationTransaction, conversationId: string) {
  const area = await findArea(tx, conversationId);
  if (!area) return;
  await revokeConsent(tx, area);
  await tx.client.query(`UPDATE ${qualified(tx.schema, 'tf_execution_areas')} SET state='deleting' WHERE id=$1`, [
    area.id,
  ]);
}
