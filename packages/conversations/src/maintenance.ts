import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { knowledgeEmbeddingProfile } from '@tulipfarm/config';
import {
  AccessDenied,
  SourceAuthorizationUnavailable,
  currentMember,
  lockAuthorization,
  requireProtectedSource,
  protectedSourceClosure,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { CreditAttemptAlreadyDispatched, CreditsExhausted, requireCredits } from '@tulipfarm/workspace-storage/credits';
import type { ConversationRuntime } from './runtime.ts';
import { chatAccess } from './chat-access.ts';
import { ConversationConflict } from './contracts.ts';
import {
  handoff,
  insertCompaction,
  insertStatusMessage,
  replaceWorkingSummary,
  summarize,
  workingSummarySchema,
  type ConversationCompactor,
  type ContextMessage,
  type EffectiveCompactionPolicy,
} from './compaction.ts';
import { mergeSources, sourceDependenciesSchema, type SourceDependency } from './results.ts';
import { notifyConversationChange } from './event-publisher.ts';
import {
  maintenanceViewSchema,
  maintenanceWorkSchema,
  type MaintenanceFence,
  type MaintenanceWork,
} from './maintenance-contracts.ts';
import { errorType, log, telemetryErrorCode } from '@tulipfarm/observability';
import { reconcileMaintenanceMemory } from './memory-reconciliation.ts';

const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
export const maintenanceCompatibility = { minimum: 1, maximum: commonCompatibility.maximum };
const batchSize = 50;
const leaseSeconds = 600;
const policySchema = z.object({
  automatic: z.boolean(),
  triggerPercent: z.number(),
  targetPercent: z.number(),
  outputPrompt: z.string().nullable(),
  revision: z.number().int(),
  families: z.array(z.string()),
});
const progressSchema = z.object({
  summary: workingSummarySchema,
  familyId: z.string().nullable(),
  fallbackFrom: z.string().nullable(),
  nextChunk: z.number().int().nullable(),
});
const jobSchema = z.object({
  id: z.uuid(),
  conversation_id: z.uuid(),
  generation: z.number().int(),
  epoch: z.number().int(),
  attempts: z.number().int(),
  requester_user_id: z.string(),
  requester_membership_id: z.uuid(),
  sources: sourceDependenciesSchema,
  recap: z.string().nullable(),
  compaction_id: z.uuid().nullable(),
  covered_through: z.number().int().nullable(),
  coverage_message_id: z.uuid().nullable(),
  previous_compaction_id: z.uuid().nullable(),
  resume_command_id: z.uuid().nullable(),
  compaction_policy: policySchema.nullable(),
  summary_progress: progressSchema.nullable(),
});
type Job = z.infer<typeof jobSchema>;
const knownFailures = new Set([
  'maintenance-empty',
  'maintenance-stale',
  'compaction-model-unavailable',
  'compaction-model-failed',
  'compaction-invalid-summary',
  'compaction-ineffective',
  'compaction-unmeasured',
  'compaction-families-unavailable',
  'memory-invalid-preferences',
  'memory-too-large',
]);
export type ConversationRecapPublication = {
  workspaceId: string;
  conversationId: string;
  generation: number;
  coverageMessageId: string;
  coveredThrough: number;
  title: string;
  text: string;
  sources: SourceDependency[];
  requester: HumanActor;
  resumeCommandId?: string;
};
export type ConversationRecapPublisher = (
  input: ConversationRecapPublication,
) => Promise<{ documentId: string; revisionId: string; embeddingStatus: string }>;
const requester = (job: Job): HumanActor => ({
  kind: 'human',
  userId: job.requester_user_id,
  membershipId: job.requester_membership_id,
});
const eligible = (tx: AuthorizationTransaction, alias = 'c') => `${alias}.kind='private' AND ${alias}.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_projects')} p WHERE p.id=${alias}.project_id AND p.archived_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_slack_default_turns')} s WHERE s.conversation_id=${alias}.id)
  AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_slack_dm_roots')} s WHERE s.conversation_id=${alias}.id)`;
const idle = (
  tx: AuthorizationTransaction,
  alias = 'c',
) => `NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_conversation_turns')} t
  WHERE t.conversation_id=${alias}.id AND t.status IN ('queued','processing','waiting'))`;

export async function readMaintenance(tx: AuthorizationTransaction, conversationId: string) {
  const row = (
    await tx.client.query(
      `SELECT id, generation, covered_through AS "coveredThrough", state, error_code AS "errorCode",
    CASE WHEN state IN ('queued','failed') THEN to_char(next_attempt_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "retryAt",
    compaction_id AS "compactionId", COALESCE((SELECT e.state FROM ${table(tx, 'tf_knowledge_embedding_jobs')} e
      JOIN ${table(tx, 'tf_knowledge_documents')} d ON d.id=e.document_id
        AND d.observed_revision_id=e.revision_id AND d.lexical_publication_id=e.publication_id
      WHERE e.document_id=j.document_id AND e.revision_id=j.revision_id AND e.purpose='ingestion' AND e.profile_id=$2),embedding_status) AS "embeddingStatus"
    FROM ${table(tx, 'tf_conversation_maintenance')} j WHERE conversation_id=$1 ORDER BY generation DESC LIMIT 1`,
      [conversationId, knowledgeEmbeddingProfile.id],
    )
  ).rows[0];
  return maintenanceViewSchema.parse({ maintenance: row ?? null });
}

export async function resumeMaintenance(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  conversationId: string,
  commandId: string,
) {
  await currentMember(tx, actor);
  await chatAccess(tx, actor, conversationId, 'turn', true);
  const prior = (
    await tx.client.query(
      `SELECT conversation_id FROM ${table(tx, 'tf_conversation_maintenance_commands')} WHERE membership_id=$1 AND command_id=$2`,
      [actor.membershipId, commandId],
    )
  ).rows[0];
  if (prior) {
    if (prior.conversation_id !== conversationId) throw new ConversationConflict('command-conflict');
    return;
  }
  const changed = await tx.client.query(
    `UPDATE ${table(tx, 'tf_conversation_maintenance')} j SET requester_user_id=$2, requester_membership_id=$3,
    state=CASE WHEN recap IS NULL THEN 'queued' ELSE 'publishing' END, next_attempt_at=clock_timestamp(), dispatched_at=NULL, error_code=NULL,
    epoch=epoch+1, lease_until=NULL, resume_command_id=$4, updated_at=clock_timestamp(),
    memory_step=memory_step+1,memory_base_revision=NULL
    FROM ${table(tx, 'tf_conversations')} c WHERE j.conversation_id=$1 AND c.id=j.conversation_id AND c.is_closed
    AND c.activity_generation=j.generation AND j.error_code IS DISTINCT FROM 'generation-unconfirmed' AND (j.state IN ('blocked','failed') OR (j.state='ready' AND EXISTS (
      SELECT 1 FROM ${table(tx, 'tf_knowledge_embedding_jobs')} e
      JOIN ${table(tx, 'tf_knowledge_documents')} d ON d.id=e.document_id
        AND d.observed_revision_id=e.revision_id AND d.lexical_publication_id=e.publication_id
      WHERE e.document_id=j.document_id AND e.revision_id=j.revision_id AND e.profile_id=$5
      AND e.purpose='ingestion' AND e.state IN ('credits-blocked','capacity-blocked','failed','unknown'))))
    AND ${eligible(tx)} AND ${idle(tx)}`,
    [conversationId, actor.userId, actor.membershipId, commandId, knowledgeEmbeddingProfile.id],
  );
  if (!changed.rowCount) throw new ConversationConflict('maintenance-not-resumable');
  await tx.client.query(`INSERT INTO ${table(tx, 'tf_conversation_maintenance_commands')} VALUES ($1,$2,$3)`, [
    actor.membershipId,
    commandId,
    conversationId,
  ]);
}

/** Called under the authorization lock before each external call and each saved result. */
export async function requireMaintenanceFence(tx: AuthorizationTransaction, fence: MaintenanceFence) {
  const chat = (
    await tx.client.query(
      `SELECT c.title, c.next_message_sequence FROM ${table(tx, 'tf_conversations')} c
    WHERE c.id=$1 AND c.is_closed AND c.activity_generation=$2 AND ${eligible(tx)} AND ${idle(tx)} FOR UPDATE`,
      [fence.conversationId, fence.generation],
    )
  ).rows[0];
  if (!chat) throw new Error('maintenance-stale');
  const row = (
    await tx.client.query(
      `SELECT * FROM ${table(tx, 'tf_conversation_maintenance')}
    WHERE id=$1 AND conversation_id=$2 AND generation=$3 AND epoch=$4 AND state IN ('running','publishing')
    AND lease_until>clock_timestamp() FOR UPDATE`,
      [fence.jobId, fence.conversationId, fence.generation, fence.epoch],
    )
  ).rows[0];
  if (!row) throw new Error('maintenance-stale');
  const job = jobSchema.parse(row);
  const actor = requester(job);
  await currentMember(tx, actor);
  await chatAccess(tx, actor, fence.conversationId, 'turn');
  for (const source of job.sources) {
    if (source.kind === 'private-conversation' && source.conversationId === fence.conversationId) continue;
    await requireProtectedSource(tx, actor, source);
  }
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET lease_until=clock_timestamp()+$2*interval '1 second' WHERE id=$1`,
    [fence.jobId, leaseSeconds],
  );
  return {
    job,
    actor,
    title: z.string().parse(chat.title),
    sequence: z.number().int().parse(chat.next_message_sequence),
  };
}

export function createConversationMaintenance(runtime: ConversationRuntime) {
  const transaction = <T>(workspaceId: string, operation: (tx: AuthorizationTransaction) => Promise<T>) =>
    runtime.transaction(workspaceId, maintenanceCompatibility, async tx => {
      await lockAuthorization(tx);
      return operation(tx);
    });

  async function sweep(workspaceId: string): Promise<{ closed: number; queued: number }> {
    return transaction(workspaceId, async tx => {
      const state = (
        await tx.client
          .query(`SELECT *, close_due_at<=clock_timestamp() AS close_due, scan_due_at<=clock_timestamp() AS scan_due
        FROM ${table(tx, 'tf_conversation_maintenance_sweep')} WHERE id=1 FOR UPDATE SKIP LOCKED`)
      ).rows[0];
      if (!state) return { closed: 0, queued: 0 };
      let closed = 0,
        queued = 0;
      if (state.close_due) {
        const chats = (
          await tx.client.query(
            `SELECT c.id FROM ${table(tx, 'tf_conversations')} c WHERE NOT c.is_closed
          AND c.activity_at<=clock_timestamp()-interval '1 hour' AND ($1::uuid IS NULL OR c.id>$1) AND ${eligible(tx)} AND ${idle(tx)}
          ORDER BY c.id LIMIT ${batchSize} FOR UPDATE OF c`,
            [state.close_after],
          )
        ).rows;
        for (const chat of chats) {
          await tx.client.query(`UPDATE ${table(tx, 'tf_conversations')} SET is_closed=true WHERE id=$1`, [chat.id]);
          await notifyConversationChange(tx, { workspaceId, conversationId: chat.id });
        }
        closed = chats.length;
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_maintenance_sweep')} SET close_after=$1,
          close_due_at=CASE WHEN $1::uuid IS NULL THEN clock_timestamp()+interval '1 minute' ELSE clock_timestamp() END WHERE id=1`,
          [chats.length === batchSize ? chats.at(-1)!.id : null],
        );
      }
      if (state.scan_due) {
        const chats = (
          await tx.client.query(
            `SELECT c.id, c.activity_generation, sender.user_id, sender.membership_id
          FROM ${table(tx, 'tf_conversations')} c JOIN LATERAL (
            SELECT m.membership_id, member.user_id FROM ${table(tx, 'tf_conversation_messages')} m
            JOIN ${table(tx, 'tf_memberships')} member ON member.id=m.membership_id
            WHERE m.conversation_id=c.id AND m.author_kind='human' ORDER BY m.sequence DESC LIMIT 1
          ) sender ON true WHERE c.is_closed AND ($1::uuid IS NULL OR c.id>$1) AND ${eligible(tx)} AND ${idle(tx)}
          AND EXISTS (SELECT 1 FROM ${table(tx, 'tf_conversation_parts')} p WHERE p.conversation_id=c.id
            AND ((p.kind='text' AND length(btrim(p.text))>0) OR p.kind IN ('request','response','approval','approval-resolution'))
            AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_internal_publications')} i WHERE i.message_id=p.message_id))
          ORDER BY c.id LIMIT ${batchSize} FOR UPDATE OF c`,
            [state.scan_after],
          )
        ).rows;
        for (const chat of chats) {
          const inserted = await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_maintenance')} (id,conversation_id,generation,requester_user_id,requester_membership_id)
            VALUES ($1,$2,$3,$4,$5) ON CONFLICT (conversation_id,generation) DO NOTHING`,
            [randomUUID(), chat.id, chat.activity_generation, chat.user_id, chat.membership_id],
          );
          queued += inserted.rowCount ?? 0;
        }
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_maintenance_sweep')} SET scan_after=$1,
          scan_due_at=CASE WHEN $1::uuid IS NULL THEN clock_timestamp()+interval '30 minutes' ELSE clock_timestamp() END WHERE id=1`,
          [chats.length === batchSize ? chats.at(-1)!.id : null],
        );
      }
      return { closed, queued };
    });
  }

  async function dispatch(
    workspaceId: string,
    start: (work: MaintenanceWork & { dispatchEpoch: number }) => Promise<void>,
    stopped = () => false,
  ) {
    const jobs = await transaction(workspaceId, async tx => {
      const rows = (
        await tx.client
          .query(`SELECT j.id, j.conversation_id, j.generation, j.epoch FROM ${table(tx, 'tf_conversation_maintenance')} j
        WHERE (j.state IN ('queued','failed','running','publishing') OR (j.state='ready' AND NOT j.memory_complete)
          OR (j.state='blocked' AND j.error_code='knowledge-capacity-blocked')) AND j.next_attempt_at<=clock_timestamp()
        AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp())
        AND (j.dispatched_at IS NULL OR j.dispatched_at<=clock_timestamp()-interval '10 minutes')
        ORDER BY j.next_attempt_at,j.id LIMIT 10 FOR UPDATE SKIP LOCKED`)
      ).rows;
      for (const row of rows)
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET dispatched_at=clock_timestamp() WHERE id=$1`,
          [row.id],
        );
      return rows.map(row => ({
        ...maintenanceWorkSchema.parse({
          workspaceId,
          conversationId: row.conversation_id,
          jobId: row.id,
          generation: row.generation,
        }),
        dispatchEpoch: Number(row.epoch),
      }));
    });
    for (const job of jobs) {
      if (stopped()) return;
      try {
        await start(job);
      } catch (error) {
        await transaction(workspaceId, tx =>
          tx.client.query(
            `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET dispatched_at=NULL,
          next_attempt_at=clock_timestamp()+interval '30 seconds' WHERE id=$1 AND epoch=$2`,
            [job.jobId, job.dispatchEpoch],
          ),
        );
        throw error;
      }
    }
  }

  async function claim(work: MaintenanceWork): Promise<MaintenanceFence | null> {
    return transaction(work.workspaceId, async tx => {
      const chat = (
        await tx.client.query(
          `SELECT c.id FROM ${table(tx, 'tf_conversations')} c
        WHERE c.id=$1 AND c.is_closed AND c.activity_generation=$2 AND ${eligible(tx)} AND ${idle(tx)} FOR UPDATE`,
          [work.conversationId, work.generation],
        )
      ).rows[0];
      if (!chat) {
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET state='stale',lease_until=NULL WHERE id=$1`,
          [work.jobId],
        );
        return null;
      }
      const row = (
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET state=CASE WHEN recap IS NULL THEN 'running' ELSE 'publishing' END,
        epoch=epoch+1, attempts=attempts+1, lease_until=clock_timestamp()+$4*interval '1 second', updated_at=clock_timestamp()
        WHERE id=$1 AND conversation_id=$2 AND generation=$3 AND (state IN ('queued','failed','running','publishing')
          OR (state='ready' AND NOT memory_complete) OR (state='blocked' AND error_code='knowledge-capacity-blocked'))
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND next_attempt_at<=clock_timestamp() RETURNING epoch`,
          [work.jobId, work.conversationId, work.generation, leaseSeconds],
        )
      ).rows[0];
      return row ? { ...work, kind: 'maintenance', epoch: Number(row.epoch) } : null;
    });
  }

  async function process(value: unknown, compactor: ConversationCompactor, publish: ConversationRecapPublisher) {
    const work = maintenanceWorkSchema.parse(value);
    const fence = await claim(work);
    if (!fence) return 'idle';
    try {
      const source = await transaction(work.workspaceId, async tx => {
        let current = await requireMaintenanceFence(tx, fence);
        if (current.job.recap) return { current, snapshot: null };
        const previous = (
          await tx.client.query(
            `SELECT compaction_id, covered_through, summary, sources FROM ${table(tx, 'tf_conversation_working_summaries')}
          WHERE conversation_id=$1 AND active`,
            [work.conversationId],
          )
        ).rows[0];
        const messages = z
          .array(
            z.object({
              id: z.uuid(),
              role: z.enum(['user', 'assistant']),
              acceptedSequence: z.number().int(),
              sequence: z.number().int(),
              text: z.string(),
            }),
          )
          .parse(
            (
              await tx.client.query(
                `SELECT m.id, CASE m.author_kind WHEN 'human' THEN 'user' ELSE 'assistant' END AS role, m.sequence,
            t.accepted_sequence AS "acceptedSequence",
            COALESCE((SELECT string_agg(CASE p.kind WHEN 'text' THEN p.text
              WHEN 'request' THEN (SELECT 'Question: '||prompt||E'\nAnswer options: '||answer_schema::text FROM ${table(tx, 'tf_conversation_requests')} WHERE id=p.request_id)
              WHEN 'response' THEN (SELECT 'Answer: '||answer::text FROM ${table(tx, 'tf_conversation_responses')} WHERE id=p.response_id)
              WHEN 'approval' THEN (SELECT 'Approval request: '||prompt FROM ${table(tx, 'tf_conversation_approval_requests')} WHERE id=p.approval_id)
              WHEN 'approval-resolution' THEN (SELECT 'Approval decision: '||resolution FROM ${table(tx, 'tf_conversation_approval_resolutions')} WHERE request_id=p.approval_id)
              END,E'\n' ORDER BY p.ordinal) FROM ${table(tx, 'tf_conversation_parts')} p WHERE p.message_id=m.id),'') AS text
            FROM ${table(tx, 'tf_conversation_messages')} m JOIN ${table(tx, 'tf_conversation_turns')} t ON t.source_message_id=m.id OR t.response_message_id=m.id
              OR t.id=(SELECT r.turn_id FROM ${table(tx, 'tf_conversation_parts')} p
                LEFT JOIN ${table(tx, 'tf_conversation_responses')} a ON a.id=p.response_id
                JOIN ${table(tx, 'tf_conversation_requests')} r ON r.id=COALESCE(p.request_id,a.request_id) WHERE p.message_id=m.id LIMIT 1)
              OR t.id=(SELECT r.turn_id FROM ${table(tx, 'tf_conversation_parts')} p
                JOIN ${table(tx, 'tf_conversation_approval_requests')} r ON r.id=p.approval_id WHERE p.message_id=m.id LIMIT 1)
            WHERE m.conversation_id=$1 AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_conversation_parts')} p WHERE p.message_id=m.id AND p.kind IN ('compact','compaction'))
            AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_internal_publications')} p WHERE p.message_id=m.id)
            ORDER BY m.sequence`,
                [work.conversationId],
              )
            ).rows,
          );
        if (!messages.some(message => message.text.trim())) throw new Error('maintenance-empty');
        const results = (
          await tx.client.query(
            `SELECT sources FROM ${table(tx, 'tf_conversation_results')} WHERE conversation_id=$1`,
            [work.conversationId],
          )
        ).rows;
        const sources = mergeSources(
          await protectedSourceClosure(tx, [
            { kind: 'private-conversation', conversationId: work.conversationId },
            ...(previous ? sourceDependenciesSchema.parse(previous.sources) : []),
            ...results.flatMap(row => sourceDependenciesSchema.parse(row.sources)),
          ]),
        );
        const last = messages.at(-1)!;
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET sources=$2, covered_through=$3,coverage_message_id=$4,previous_compaction_id=$5 WHERE id=$1`,
          [
            work.jobId,
            JSON.stringify(sources),
            Math.max(...messages.map(message => message.acceptedSequence)),
            last.id,
            previous?.compaction_id ?? null,
          ],
        );
        current = await requireMaintenanceFence(tx, fence);
        await requireCredits(tx);
        const policy: EffectiveCompactionPolicy = current.job.compaction_policy ?? (await compactor.policy(tx));
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET compaction_policy=$2 WHERE id=$1 AND compaction_policy IS NULL`,
          [work.jobId, JSON.stringify(policy)],
        );
        return {
          current,
          snapshot: {
            previous: previous ? workingSummarySchema.parse(previous.summary) : null,
            previousId: previous?.compaction_id as string | undefined,
            uncovered: messages.filter(
              message => message.acceptedSequence > (Number(previous?.covered_through) || 0),
            ) as ContextMessage[],
            policy,
          },
        };
      });
      if (source.snapshot) {
        const { snapshot } = source;
        const progress = source.current.job.summary_progress;
        const generated =
          progress?.nextChunk === null
            ? progress
            : snapshot.uncovered.length
              ? await summarize(
                  compactor,
                  fence,
                  snapshot.policy.families,
                  progress?.summary ?? snapshot.previous,
                  snapshot.uncovered,
                  { fromChunk: progress?.nextChunk ?? 0, maxChunks: 4 },
                )
              : { summary: snapshot.previous!, familyId: null, fallbackFrom: null, nextChunk: null };
        if (!generated.summary) throw new Error('maintenance-empty');
        await transaction(work.workspaceId, async tx => {
          await requireMaintenanceFence(tx, fence);
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET summary_progress=$2 WHERE id=$1`,
            [work.jobId, JSON.stringify(generated)],
          );
          if (generated.nextChunk !== null)
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET state='queued',lease_until=NULL,
            dispatched_at=NULL,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
              [work.jobId],
            );
        });
        if (generated.nextChunk !== null) return 'queued';
        const recap = await handoff(
          compactor,
          fence,
          snapshot.policy.families,
          snapshot.policy.outputPrompt,
          generated.summary,
          [],
        );
        await transaction(work.workspaceId, async tx => {
          const current = await requireMaintenanceFence(tx, fence);
          const id = randomUUID();
          await insertCompaction(tx, {
            id,
            conversationId: work.conversationId,
            turnId: null,
            trigger: 'inactivity',
            state: 'compacted',
            previousId: snapshot.previousId ?? null,
            coveredThrough: current.job.covered_through,
            policyRevision: snapshot.policy.revision,
            familyId: generated.familyId,
            fallbackFrom: generated.fallbackFrom,
            before: null,
            afterTokens: null,
            triggerPercent: snapshot.policy.triggerPercent,
            targetPercent: snapshot.policy.targetPercent,
            errorCode: null,
          });
          if (
            !(await replaceWorkingSummary(tx, {
              conversationId: work.conversationId,
              compactionId: id,
              expectedPrevious: snapshot.previousId ?? null,
              coveredThrough: current.job.covered_through!,
              summary: generated.summary,
              protectedMessageIds: generated.summary.protectedMessageIds,
              sources: current.job.sources,
            }))
          )
            throw new Error('maintenance-stale');
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_handoffs')} (compaction_id,conversation_id,status,text,model_family_id,fallback_from_family_id,attempts,sources)
            VALUES ($1,$2,'completed',$3,$4,$5,1,$6)`,
            [
              id,
              work.conversationId,
              recap.text,
              recap.familyId,
              recap.fallbackFrom,
              JSON.stringify(current.job.sources),
            ],
          );
          await insertStatusMessage(tx, work.conversationId, current.sequence, id);
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_conversations')} SET next_message_sequence=next_message_sequence+1 WHERE id=$1`,
            [work.conversationId],
          );
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET compaction_id=$2,recap=$3,state='publishing',updated_at=clock_timestamp() WHERE id=$1`,
            [work.jobId, id, recap.text],
          );
          await notifyConversationChange(tx, { workspaceId: work.workspaceId, conversationId: work.conversationId });
        });
      }
      const memoryComplete = await reconcileMaintenanceMemory(
        operation =>
          transaction(work.workspaceId, async tx => {
            const { actor, job } = await requireMaintenanceFence(tx, fence);
            return operation(tx, { actor, coveredThrough: job.covered_through, policy: job.compaction_policy });
          }),
        fence,
        compactor,
      );
      if (!memoryComplete) {
        await transaction(work.workspaceId, async tx => {
          await requireMaintenanceFence(tx, fence);
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET state='publishing',lease_until=NULL,
            dispatched_at=NULL,next_attempt_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE id=$1`,
            [work.jobId],
          );
        });
        return 'queued';
      }
      const publication = await transaction(work.workspaceId, async tx => {
        const current = await requireMaintenanceFence(tx, fence);
        return {
          workspaceId: work.workspaceId,
          conversationId: work.conversationId,
          generation: work.generation,
          coverageMessageId: current.job.coverage_message_id!,
          coveredThrough: current.job.covered_through!,
          title: current.title,
          text: current.job.recap!,
          sources: current.job.sources,
          requester: current.actor,
          ...(current.job.resume_command_id ? { resumeCommandId: current.job.resume_command_id } : {}),
        };
      });
      const published = await publish(publication);
      await transaction(work.workspaceId, async tx => {
        await requireMaintenanceFence(tx, fence);
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET state='ready',document_id=$2,revision_id=$3,embedding_status=$4,
          lease_until=NULL,error_code=NULL,updated_at=clock_timestamp() WHERE id=$1`,
          [work.jobId, published.documentId, published.revisionId, published.embeddingStatus],
        );
        await notifyConversationChange(tx, { workspaceId: work.workspaceId, conversationId: work.conversationId });
      });
      return 'ready';
    } catch (error) {
      const stale =
        error instanceof Error && (error.message === 'maintenance-stale' || error.message === 'maintenance-empty');
      const capacity = typeof error === 'object' && error !== null && 'code' in error && error.code === 'quota';
      const unavailable = error instanceof SourceAuthorizationUnavailable;
      const denied = error instanceof AccessDenied && !unavailable;
      const memoryFailure =
        error instanceof Error && ['memory-invalid-preferences', 'memory-too-large'].includes(error.message);
      const blocked = denied || error instanceof CreditAttemptAlreadyDispatched || capacity || memoryFailure;
      const code = denied
        ? 'access-denied'
        : unavailable
          ? 'source-unavailable'
          : error instanceof CreditAttemptAlreadyDispatched
            ? 'generation-unconfirmed'
            : capacity
              ? 'knowledge-capacity-blocked'
              : error instanceof CreditsExhausted
                ? 'credits-exhausted'
                : error instanceof Error && knownFailures.has(error.message)
                  ? error.message
                  : 'maintenance-failed';
      const storageCode = telemetryErrorCode(
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
      );
      log('error', 'activity', 'call_failed', {
        operation: 'conversation.maintenance',
        'error.type': errorType(error),
        'error.code': code,
        ...(storageCode ? { 'error.storageCode': storageCode } : {}),
      });
      await transaction(work.workspaceId, async tx => {
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_maintenance')} SET state=$3,error_code=$4,lease_until=NULL,dispatched_at=NULL,
          next_attempt_at=clock_timestamp()+LEAST(1800,30*power(2,LEAST(attempts,6)))*interval '1 second',updated_at=clock_timestamp()
          WHERE id=$1 AND epoch=$2 AND state IN ('running','publishing')`,
          [work.jobId, fence.epoch, stale ? 'stale' : blocked ? 'blocked' : 'failed', code],
        );
        await notifyConversationChange(tx, { workspaceId: work.workspaceId, conversationId: work.conversationId });
      });
      return stale ? 'stale' : blocked ? 'blocked' : 'failed';
    }
  }
  return { sweep, dispatch, process };
}
