import { randomUUID } from 'node:crypto';
import { recordConversationActivity } from './activity.ts';
import { createConversationRequests } from './requests.ts';
import { presentChoiceSchema } from './request-contracts.ts';
import { z } from 'zod';
import { defaultCallTimeoutMs } from '@tulipfarm/config/timeouts';
import { storedToolPresentation } from './tool-activity-history.ts';
import { toolPresentation } from './tool-activity.ts';
import {
  AccessDenied,
  SourceAuthorizationUnavailable,
  currentMember,
  lockAuthorization,
  uuidSchema,
  type HumanActor,
  type AuthorizationTransaction,
} from '@tulipfarm/access';
import { requireCredits, CreditsExhausted, CreditAttemptAlreadyDispatched } from '@tulipfarm/workspace-storage/credits';
import {
  qualified,
  StorageUnavailableError,
  type createWorkspaceRuntime,
  commonCompatibility,
} from '@tulipfarm/workspace-storage/runtime';
import {
  chatToolCallLimit,
  defaultConversationModel,
  toolReceiptSchema,
  turnStatusSchema,
  timeZoneSchema,
} from './contracts.ts';
import { interruptToolReceipts } from './tool-receipts.ts';
import { notifyConversationChange, notifyConversationTool } from './event-publisher.ts';
import {
  conversationResult,
  conversationResultSchema,
  mergeSources,
  type ConversationResult,
  type SourceDependency,
} from './results.ts';
import { turnRequester } from './turn-requester.ts';
import {
  requireFileSources,
  requireGitHubSources,
  requireGoogleFileSources,
  requireGoogleSources,
  requireKnowledgeSources,
  requireWorkflowSources,
  requireResultSources,
  requireSlackTurn,
  requireMcpSources,
  requireConversationMcpSources,
} from './source-access.ts';
import {
  bindFileSources,
  readReferencedFiles,
  storedReferenceSchema,
  type FileContent,
  type FileSource,
  type GoogleFileReader,
} from './file-references.ts';
import { projectReaders, requireProjectAccess } from './project-membership.ts';
import { projectPassageFileSources } from './project-file-sources.ts';
import { captureProjectContext, recheckProjectContext } from './projects.ts';
import { projectContextSchema, RequiredProjectContextTooLarge, type ProjectContext } from './project-context.ts';
import { readPersonalMemory } from './personal-memory.ts';
import {
  insertSkillPart,
  requestedSkill,
  skillReminder,
  skillSources,
  type ChatSkills,
  type InvokedSkill,
} from './skill-invocations.ts';
import { isCalendarReadCall } from '@tulipfarm/google-workspace/calendar-events';
import {
  errorType,
  log,
  observeChatStage,
  observeChatDetail,
  observeChatDetailSync,
  withChatMeasurements,
  telemetryErrorCode,
  toolFailureLogged,
} from '@tulipfarm/observability';
import {
  breakerOpen,
  cleanedFileNote,
  compactCommand,
  compactionFailure,
  compactionSnapshot,
  handoff,
  insertCompaction,
  insertStatusMessage,
  recordCleanups,
  replaceWorkingSummary,
  summarize,
  summaryBlock,
  summaryHeading,
  updateBreaker,
  workingSummarySchema,
  type ChatMessage,
  type CompactionError,
  type CompactionRecord,
  type ContextMeasure,
  type ContextMessage,
  type ConversationCompactor,
  type EffectiveCompactionPolicy,
  type WorkingSummary,
} from './compaction.ts';

export type ConversationRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
type RuntimeTransaction = Parameters<Parameters<ConversationRuntime['transaction']>[2]>[0];
export const replyWorkSchema = z.strictObject({
  workspaceId: uuidSchema,
  conversationId: uuidSchema,
  turnId: uuidSchema,
  generation: z.number().int().nonnegative(),
});
export type ReplyWork = z.infer<typeof replyWorkSchema>;
const fenceSchema = replyWorkSchema.extend({ epoch: z.number().int().positive() });
export type ReplyFence = z.infer<typeof fenceSchema>;
/** Where a failed reply stopped. Logged as a fixed label so a denial can be located without request content or identifiers. */
type ReplyStage =
  | 'resume'
  | 'claim'
  | 'context'
  | 'prepare'
  | 'compaction'
  | 'files'
  | 'model'
  | 'memory'
  | 'tool'
  | 'tool-recovery'
  | 'delivery';
const failedStages = new WeakMap<object, ReplyStage>();
async function staged<T>(stage: ReplyStage, action: () => Promise<T>): Promise<T> {
  try {
    return await observeChatStage(stage, action);
  } catch (error) {
    if (typeof error === 'object' && error !== null && !failedStages.has(error)) failedStages.set(error, stage);
    throw error;
  }
}
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const turnSchema = z.object({
  id: uuidSchema,
  source_message_id: uuidSchema,
  accepted_sequence: z.number().int(),
  responder: z.string(),
  status: turnStatusSchema,
  attempt_epoch: z.number().int(),
  attempts: z.number().int(),
  generation: z.number().int(),
  lease_live: z.boolean(),
  retry_due: z.boolean(),
  planning_mode: z.boolean(),
});

export type ConversationToolContext = {
  runtime: ConversationRuntime;
  workspaceId: string;
  actor: HumanActor;
  callId: string;
  origin: {
    conversationId: string;
    turnId: string;
    sources: SourceDependency[];
    files?: readonly FileSource[];
    generation?: number;
    epoch?: number;
  };
};
export type ConversationReply = (input: {
  model: string;
  messages: { role: 'user' | 'assistant'; text: string }[];
  sourceMessages?: { role: 'user' | 'assistant'; text: string }[];
  fence: ReplyFence;
  /** Fresh, runtime-authorized preference context, excluded from snapshots and history. */
  readPersonalMemory: () => Promise<{ content: string; revision: number } | undefined>;
  generateTitle: boolean;
  timeZone: string | null;
  priorCalls?: number;
  priorToolCalls?: readonly unknown[];
  /** The working context holds a compaction summary, so earlier messages may be reread by id. */
  earlierMessages?: boolean;
  retainedSources?: SourceDependency[];
  describedHandles?: string[];
  project?: ProjectContext;
  executeTool: (
    name: string,
    external: boolean,
    operation: (context: ConversationToolContext) => Promise<unknown>,
    dependencies?: readonly SourceDependency[],
    call?: unknown,
    activity?: string,
  ) => Promise<unknown>;
}) => Promise<string | ConversationResult>;
const historySchema = z.array(
  z.object({
    id: uuidSchema,
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    acceptedSequence: z.number().int(),
  }),
);

function replyParts(text: string) {
  const parts: string[] = [];
  let part = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 65536) {
      parts.push(part);
      part = '';
      bytes = 0;
    }
    part += character;
    bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}

export type ExternalConversationContext = (
  tx: AuthorizationTransaction,
  work: ReplyWork,
  sources?: readonly SourceDependency[],
) => Promise<{ kind: 'channel' | 'private'; sources: SourceDependency[] }>;
export type ResumeExternalAction = (workspaceId: string, turnId: string) => Promise<{ status: string; id: string }>;
export type ResumeMcpAction = (
  context: ConversationToolContext,
  call: unknown,
) => Promise<{ result: { kind: string; actionId?: string; status?: string }; sources: SourceDependency[] }>;
const executionStepSchema = z.object({
  call_id: uuidSchema,
  call: z.json(),
  sources: conversationResultSchema.shape.sources,
  output: z.json().nullable(),
  tool: z.string(),
  status: z.string(),
});
const mcpWaitSchema = z.object({
  result: z.object({ provider: z.literal('workspace-mcp'), kind: z.literal('waiting'), actionId: uuidSchema }),
});
const protectedOutputSchema = z.object({ result: z.unknown(), sources: conversationResultSchema.shape.sources });
class ExternalActionWaiting extends Error {}
const privateReply =
  'This answer uses information that some project members cannot see, so it was not shared here. Ask again in a private chat.';
const modelFailureSchema = z.enum([
  'model-configuration',
  'model-authentication',
  'model-permission',
  'model-quota',
  'model-rate-limit',
  'model-overload',
  'model-unavailable',
  'model-refusal',
  'model-context-overflow',
  'model-invalid-request',
  'model-invalid-decision',
  'model-incomplete-response',
  'model-output-limit',
  'model-cancelled',
  'model-timeout',
  'model-transport',
  'model-provider-error',
]);

export async function renewConversationReplyLease(
  tx: AuthorizationTransaction,
  fence: ReplyFence,
  leaseMs = 60_000,
): Promise<void> {
  // Match the executor's conversation-before-turn lock order.
  await tx.client.query(`SELECT id FROM ${table(tx, 'tf_conversations')} WHERE id=$1 FOR UPDATE`, [
    fence.conversationId,
  ]);
  const renewed = await tx.client.query(
    `UPDATE ${table(tx, 'tf_conversation_turns')} SET lease_until=clock_timestamp()+$5*interval '1 millisecond'
    WHERE id=$1 AND conversation_id=$2 AND generation=$3 AND attempt_epoch=$4
      AND status='processing' AND lease_until>clock_timestamp()`,
    [fence.turnId, fence.conversationId, fence.generation, fence.epoch, leaseMs],
  );
  if (!renewed.rowCount) throw new AccessDenied();
}

const changed = (tx: AuthorizationTransaction, work: ReplyWork, settled = false) =>
  notifyConversationChange(tx, {
    workspaceId: work.workspaceId,
    conversationId: work.conversationId,
    turnId: work.turnId,
    settled,
  });

async function failTurn(tx: AuthorizationTransaction, work: ReplyWork, code: string) {
  await tx.client.query(
    `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='failed',lease_until=NULL,retry_at=NULL,error_code=$2 WHERE id=$1`,
    [work.turnId, code],
  );
  await interruptToolReceipts(tx, work.turnId, 'failed');
  await changed(tx, work, true);
}
const skillUnavailable = (tx: AuthorizationTransaction, work: ReplyWork) => failTurn(tx, work, 'skill-unavailable');

export type ConversationPlanning = {
  allowsResearch(name: string, call: unknown): boolean;
  authorizeTool?: (tx: RuntimeTransaction, fence: ReplyFence, name: string, callId: string) => Promise<void>;
  recordToolTime?: (tx: RuntimeTransaction, callId: string, elapsedMilliseconds: number) => Promise<void>;
  context?: (tx: RuntimeTransaction, fence: ReplyFence) => Promise<string | null>;
  finish?: (
    tx: RuntimeTransaction,
    fence: ReplyFence,
  ) => Promise<{ kind: 'continue' } | { kind: 'complete'; text?: string }>;
  failure?: (error: unknown) => { code: 'plan-budget'; instruction: string } | null;
};

export function createConversationExecutor(
  runtime: ConversationRuntime,
  reply?: ConversationReply,
  externalContext?: ExternalConversationContext,
  resumeExternal?: ResumeExternalAction,
  resumeMcp?: ResumeMcpAction,
  files?: FileContent,
  google?: GoogleFileReader,
  skills?: ChatSkills,
  compactor?: ConversationCompactor,
  planning?: ConversationPlanning,
) {
  async function transaction<T>(workspaceId: string, operation: (tx: RuntimeTransaction) => Promise<T>) {
    return runtime.transaction(workspaceId, { minimum: 1, maximum: commonCompatibility.maximum }, async tx => {
      await lockAuthorization(tx, resumeMcp ? 'write' : 'read');
      return operation(bindFileSources(tx));
    });
  }

  async function root(
    tx: RuntimeTransaction,
    work: ReplyWork,
    sourceCheck: 'conversation' | 'approved-batch' = 'conversation',
  ) {
    const { conversationId, turnId } = work;
    const chat = z
      .object({
        owner_user_id: z.string(),
        owner_membership_id: uuidSchema,
        next_message_sequence: z.number().int(),
        title_manual: z.boolean(),
        title_revision: z.number().int(),
        project_id: uuidSchema.nullable(),
      })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT owner_user_id, owner_membership_id, next_message_sequence, title_manual, title_revision, project_id AS project_id FROM ${table(tx, 'tf_conversations')} WHERE id = $1 AND kind = 'private' FOR UPDATE`,
            [conversationId],
          )
        ).rows[0],
      );
    if (!chat) return null;
    if (!chat.project_id)
      try {
        await currentMember(tx, { kind: 'human', userId: chat.owner_user_id, membershipId: chat.owner_membership_id });
      } catch (error) {
        if (!(error instanceof AccessDenied)) throw error;
        const blocked = await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_turns')} SET status = 'blocked', lease_until = NULL, retry_at = NULL, error_code = 'membership-removed', attempt_epoch = attempt_epoch + 1 WHERE conversation_id = $1 AND status NOT IN ('completed', 'cancelled', 'blocked') RETURNING id`,
          [conversationId],
        );
        for (const row of blocked.rows) await interruptToolReceipts(tx, uuidSchema.parse(row.id), 'blocked');
        if (blocked.rowCount)
          await notifyConversationChange(tx, { workspaceId: work.workspaceId, conversationId, settled: true });
        return null;
      }
    try {
      const requester = await turnRequester(tx, conversationId, turnId);
      if (chat.project_id) await requireProjectAccess(tx, requester, chat.project_id);
      else if (requester.userId !== chat.owner_user_id || requester.membershipId !== chat.owner_membership_id)
        throw new AccessDenied();
      await requireConversationMcpSources(tx, requester, conversationId);
      const external = Boolean(
        (
          await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_slack_default_turns')} WHERE conversation_id=$1`, [
            conversationId,
          ])
        ).rowCount,
      );
      if (external && !externalContext) throw new AccessDenied();
      const context = external && externalContext ? await externalContext(tx, work) : null;
      const slack = await requireSlackTurn(tx, requester, conversationId, turnId);
      if (sourceCheck === 'conversation') {
        const retained = await tx.client.query(
          `SELECT r.sources FROM ${table(tx, 'tf_conversation_results')} r JOIN ${table(tx, 'tf_conversation_turns')} t ON t.id=r.turn_id WHERE r.conversation_id=$1 AND t.accepted_sequence>=COALESCE((SELECT context_start FROM ${table(tx, 'tf_github_chat_selection')} WHERE conversation_id=$1),1) AND t.accepted_sequence<(SELECT accepted_sequence FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$2)`,
          [conversationId, turnId],
        );
        for (const row of retained.rows) await requireGitHubSources(tx, requester, row.sources);
      }
      if (slack) {
        const prior = await tx.client.query(
          `SELECT r.sources FROM ${table(tx, 'tf_conversation_results')} r JOIN ${table(tx, 'tf_conversation_turns')} t ON t.id=r.turn_id WHERE r.conversation_id=$1 AND t.accepted_sequence<(SELECT accepted_sequence FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$2)`,
          [conversationId, turnId],
        );
        for (const row of prior.rows) await requireResultSources(tx, requester, conversationId, row.sources);
      }
      return { ...chat, requester, slack, context };
    } catch (error) {
      if (!(error instanceof AccessDenied)) throw error;
      const blocked = await tx.client.query(
        `UPDATE ${table(tx, 'tf_conversation_turns')} SET status = 'blocked', lease_until = NULL, retry_at = NULL, error_code = 'requester-unavailable', attempt_epoch = attempt_epoch + 1 WHERE id = $1 AND conversation_id = $2 AND status NOT IN ('completed', 'cancelled', 'blocked')`,
        [turnId, conversationId],
      );
      if (blocked.rowCount) {
        await interruptToolReceipts(tx, turnId, 'blocked');
        await changed(tx, work, true);
      }
      return null;
    }
  }

  async function projectAudienceCanRead(
    tx: RuntimeTransaction,
    projectId: string,
    conversationId: string,
    sources: SourceDependency[],
  ) {
    for (const reader of await projectReaders(tx, projectId)) {
      try {
        await requireResultSources(tx, reader, conversationId, sources);
      } catch (error) {
        if (error instanceof AccessDenied) return false;
        throw error;
      }
    }
    return true;
  }

  async function head(tx: AuthorizationTransaction, conversationId: string) {
    return turnSchema.optional().parse(
      (
        await tx.client.query(
          `SELECT id, source_message_id, accepted_sequence, responder, status, attempt_epoch, attempts, generation, COALESCE((to_jsonb(t)->>'planning_mode')::boolean, false) AS planning_mode,
      COALESCE(lease_until > clock_timestamp(), false) AS lease_live,
      COALESCE(retry_at <= clock_timestamp(), true) AS retry_due
      FROM ${table(tx, 'tf_conversation_turns')} t WHERE conversation_id = $1 AND status NOT IN ('completed', 'cancelled', 'blocked') ORDER BY accepted_sequence LIMIT 1 FOR UPDATE`,
          [conversationId],
        )
      ).rows[0],
    );
  }

  async function claim(value: unknown): Promise<ReplyFence | null> {
    const work = replyWorkSchema.parse(value);
    return transaction(work.workspaceId, async tx => {
      const chat = await root(tx, work);
      if (!chat) return null;
      const turn = await head(tx, work.conversationId);
      if (
        !turn ||
        turn.id !== work.turnId ||
        turn.generation !== work.generation ||
        !['queued', 'processing'].includes(turn.status) ||
        turn.lease_live ||
        !turn.retry_due
      )
        return null;
      if (
        (
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_conversation_execution_steps')} s JOIN ${table(tx, 'tf_conversation_tool_calls')} c ON c.id=s.call_id WHERE s.turn_id=$1 AND c.tool='mcp.call' AND c.status='running'`,
            [turn.id],
          )
        ).rowCount
      ) {
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='waiting',lease_until=NULL,error_code='mcp-action-waiting' WHERE id=$1`,
          [turn.id],
        );
        await changed(tx, work, true);
        return null;
      }
      if (
        (
          await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_slack_conversation_actions')} WHERE turn_id=$1`, [
            turn.id,
          ])
        ).rowCount
      ) {
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='waiting',lease_until=NULL,error_code='slack-action-waiting' WHERE id=$1`,
          [turn.id],
        );
        await changed(tx, work, true);
        return null;
      }
      if (
        chat.slack &&
        (
          await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_slack_dm_events')} WHERE turn_id=$1 AND model_started`, [
            turn.id,
          ])
        ).rowCount
      ) {
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='blocked',lease_until=NULL,retry_at=NULL,error_code='slack-execution-unknown' WHERE id=$1`,
          [turn.id],
        );
        await changed(tx, work, true);
        return null;
      }
      await interruptToolReceipts(tx, turn.id, 'failed');
      if (turn.attempts >= 5) {
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_turns')} SET status = 'failed', lease_until = NULL, retry_at = NULL, error_code = 'attempts-exhausted' WHERE id = $1`,
          [turn.id],
        );
        await changed(tx, work, true);
        return null;
      }
      const epoch = turn.attempt_epoch + 1;
      try {
        await requireCredits(tx);
      } catch (error) {
        if (!(error instanceof CreditsExhausted)) throw error;
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='failed',lease_until=NULL,retry_at=NULL,error_code='credits-exhausted' WHERE id=$1`,
          [turn.id],
        );
        await changed(tx, work, true);
        return null;
      }
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_conversation_turns')} SET status = 'processing', attempt_epoch = $2, attempts = attempts + 1, lease_until = clock_timestamp() + interval '60 seconds', retry_at = NULL, error_code = NULL WHERE id = $1`,
        [turn.id, epoch],
      );
      await changed(tx, work);
      return { ...work, epoch };
    });
  }

  async function guarded<T>(
    fence: ReplyFence,
    operation: (tx: RuntimeTransaction, chat: { next_message_sequence: number }) => Promise<T>,
  ): Promise<T | 'stale'> {
    return transaction(fence.workspaceId, async tx => {
      const chat = await root(tx, fence);
      if (!chat) return 'stale';
      const turn = await head(tx, fence.conversationId);
      if (
        !turn ||
        turn.id !== fence.turnId ||
        turn.generation !== fence.generation ||
        turn.attempt_epoch !== fence.epoch ||
        turn.status !== 'processing' ||
        !turn.lease_live
      )
        return 'stale';
      return operation(tx, chat);
    });
  }

  async function bumpSequence(tx: RuntimeTransaction, conversationId: string) {
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_conversations')} SET next_message_sequence = next_message_sequence + 1 WHERE id = $1`,
      [conversationId],
    );
  }

  async function finishTurn(tx: RuntimeTransaction, fence: ReplyFence, messageId: string) {
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_conversation_turns')} SET status = 'completed', response_message_id = $2, lease_until = NULL, retry_at = NULL, error_code = NULL WHERE id = $1`,
      [fence.turnId, messageId],
    );
    await interruptToolReceipts(tx, fence.turnId, 'failed');
    await bumpSequence(tx, fence.conversationId);
    await changed(tx, fence, true);
    const next = await head(tx, fence.conversationId);
    if (next)
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_conversation_outbox')} (turn_id, conversation_id, generation) VALUES ($1,$2,$3) ON CONFLICT (turn_id, generation) DO UPDATE SET next_attempt_at = clock_timestamp(), dispatched_at = NULL`,
        [next.id, fence.conversationId, next.generation],
      );
  }

  type CompactionSource = {
    model: string;
    messages: ContextMessage[];
    project?: ProjectContext | undefined;
    generateTitle: boolean;
    timeZone: string | null;
    inherited: SourceDependency[];
  };
  const rethrown = (error: unknown) =>
    error instanceof CreditsExhausted ||
    error instanceof CreditAttemptAlreadyDispatched ||
    error instanceof AccessDenied;
  const latestSequence = (messages: readonly ContextMessage[]) =>
    messages.reduce<number | null>(
      (latest, message) => (latest === null || message.acceptedSequence > latest ? message.acceptedSequence : latest),
      null,
    );
  const protectedWording = (
    previous: readonly { id: string; text: string }[],
    summary: WorkingSummary,
    covered: readonly ContextMessage[],
  ) => {
    const known = new Map([
      ...previous.map(item => [item.id, item.text] as const),
      ...covered.filter(message => message.role === 'user').map(message => [message.id, message.text] as const),
    ]);
    const ids = [...new Set([...previous.map(item => item.id), ...summary.protectedMessageIds])]
      .filter(id => known.get(id))
      .slice(0, 32);
    return ids.map(id => ({ id, text: known.get(id)! }));
  };

  /** Applies cleanup, then a rolling summary, when the measured next request crosses the workspace trigger. Returns the model context or 'stale'. */
  async function automaticContext(
    fence: ReplyFence,
    source: CompactionSource,
    state: NonNullable<Awaited<ReturnType<typeof compactionSnapshot>>>,
    policy: EffectiveCompactionPolicy,
    compactor: ConversationCompactor,
    render: (messages: readonly ContextMessage[], cleaned: ReadonlySet<string>) => ChatMessage[],
    hasFile: (id: string) => boolean,
    tail: readonly ChatMessage[],
  ): Promise<ChatMessage[] | 'stale'> {
    let summary = state.summary;
    let wording = state.wording;
    const cleaned = new Set<string>();
    const current = source.messages.at(-1)!;
    const prior = source.messages.slice(0, -1);
    const build = () =>
      observeChatDetailSync('render', () => [
        ...(summary ? [summaryBlock(summary.summary, wording)] : []),
        ...render(
          source.messages.filter(
            message => message === current || !summary || message.acceptedSequence > summary.coveredThrough,
          ),
          cleaned,
        ),
        ...tail,
      ]);
    const measure = (messages: ChatMessage[]) =>
      observeChatDetail('context-measure', () =>
        compactor.measure({
          fence,
          model: source.model,
          messages,
          ...(source.project ? { project: source.project } : {}),
          generateTitle: source.generateTitle,
          timeZone: source.timeZone,
        }),
      );
    const fits = (measured: ContextMeasure) => measured.tokens <= measured.window;
    let context = build();
    const before = await measure(context);
    if (!before) return context;
    const threshold = Math.floor((before.window * policy.triggerPercent) / 100);
    if (before.tokens < threshold && !state.requested) return context;
    // Failing the turn ends this attempt either way; the caller only needs to stop.
    const stop = async (code: string) => {
      await guarded(fence, tx => failTurn(tx, fence, code));
      return 'stale' as const;
    };
    if (state.completed) return fits(before) ? context : stop('context-limit');
    if (!state.requested && (!policy.automatic || breakerOpen(state.breaker)))
      return fits(before) ? context : stop(policy.automatic ? 'compaction-paused' : 'context-limit');
    const latest = latestSequence(prior);
    const record: CompactionRecord = {
      id: randomUUID(),
      conversationId: fence.conversationId,
      turnId: fence.turnId,
      trigger: state.requested ? 'manual' : 'automatic',
      state: 'failed',
      previousId: summary?.compactionId ?? null,
      coveredThrough: null,
      policyRevision: policy.revision,
      familyId: null,
      fallbackFrom: null,
      before,
      afterTokens: null,
      triggerPercent: policy.triggerPercent,
      targetPercent: policy.targetPercent,
      errorCode: null,
    };
    const persist = async (
      outcome: 'effective' | 'ineffective' | CompactionError,
      next?: { summary: WorkingSummary; coveredThrough: number; protectedIds: string[] },
    ) =>
      guarded(fence, async (tx, chat) => {
        await insertCompaction(tx, record);
        if (
          next &&
          !(await replaceWorkingSummary(tx, {
            conversationId: fence.conversationId,
            compactionId: record.id,
            expectedPrevious: record.previousId,
            coveredThrough: next.coveredThrough,
            summary: next.summary,
            protectedMessageIds: next.protectedIds,
            sources: source.inherited,
          }))
        )
          throw new Error('conversation-turn-stale');
        await recordCleanups(tx, fence.conversationId, record.id, [...cleaned]);
        if (!state.requested) await updateBreaker(tx, fence.conversationId, outcome);
        await insertStatusMessage(tx, fence.conversationId, chat.next_message_sequence, record.id);
        await bumpSequence(tx, fence.conversationId);
        await changed(tx, fence);
      });
    const failed = async (code: CompactionError) => {
      Object.assign(record, { state: 'failed', errorCode: code, afterTokens: null });
      summary = state.summary;
      wording = state.wording;
      context = build();
      if ((await persist(code)) === 'stale') return 'stale' as const;
      return fits(before) ? context : stop('compaction-failed');
    };
    // Source-backed cleanup first: older file contents leave context while their originals stay attached to the message.
    for (const message of prior)
      if (latest !== null && message.acceptedSequence < latest && hasFile(message.id)) cleaned.add(message.id);
    if (cleaned.size) {
      context = build();
      const after = await measure(context);
      if (after && after.tokens < threshold && fits(after) && !state.requested) {
        Object.assign(record, { state: 'cleaned', afterTokens: after.tokens });
        return (await persist('effective')) === 'stale' ? 'stale' : context;
      }
    }
    const covered = prior.filter(message => latest !== null && message.acceptedSequence < latest && message.text);
    if (!covered.length) {
      if (!cleaned.size) return failed('compaction-ineffective');
      const after = await measure(context);
      Object.assign(record, { state: 'cleaned', afterTokens: after?.tokens ?? null });
      if ((await persist(after && after.tokens < threshold ? 'effective' : 'ineffective')) === 'stale') return 'stale';
      return after && fits(after) ? context : stop('context-limit');
    }
    if (!policy.families.length) return failed('compaction-model-unavailable');
    let result: Awaited<ReturnType<typeof summarize>>;
    try {
      result = await summarize(compactor, fence, policy.families, summary?.summary ?? null, covered);
    } catch (error) {
      if (rethrown(error)) throw error;
      return failed(compactionFailure(error));
    }
    const coveredThrough = Math.max(...covered.map(message => message.acceptedSequence), summary?.coveredThrough ?? 0);
    wording = protectedWording(state.wording, result.summary, covered);
    summary = {
      compactionId: record.id,
      revision: (summary?.revision ?? 0) + 1,
      coveredThrough,
      summary: result.summary,
      protectedMessageIds: wording.map(item => item.id),
      sources: source.inherited,
    };
    context = build();
    const after = await measure(context);
    Object.assign(record, {
      state: 'compacted',
      coveredThrough,
      familyId: result.familyId,
      fallbackFrom: result.fallbackFrom,
      afterTokens: after?.tokens ?? null,
    });
    if (
      (await persist(after && after.tokens < threshold ? 'effective' : 'ineffective', {
        summary: result.summary,
        coveredThrough,
        protectedIds: summary.protectedMessageIds,
      })) === 'stale'
    )
      return 'stale';
    return !after || fits(after) ? context : stop('context-limit');
  }

  /** A `/compact` turn: compacts everything before the latest completed exchange and writes a separate handoff. It never calls the chat responder. */
  async function compactTurn(
    fence: ReplyFence,
    source: CompactionSource & { compaction: Awaited<ReturnType<typeof compactionSnapshot>> | null },
    command: { prompt: string | null; compactionId: string | null },
    policy: EffectiveCompactionPolicy,
    compactor: ConversationCompactor,
  ): Promise<'completed' | 'stale'> {
    const state = source.compaction;
    if (!state) return 'stale';
    const prior = source.messages.slice(0, -1);
    const latest = latestSequence(prior);
    const recent = prior.filter(message => message.acceptedSequence === latest && message.text);
    const prompt = command.prompt ?? policy.outputPrompt;
    const writeHandoff = async (summary: WorkingSummary | null, format: string | null) => {
      if (!policy.families.length)
        return { status: 'failed' as const, errorCode: 'compaction-model-unavailable' as CompactionError };
      try {
        return {
          status: 'completed' as const,
          ...(await handoff(compactor, fence, policy.families, format, summary, recent)),
        };
      } catch (error) {
        if (rethrown(error)) throw error;
        return { status: 'failed' as const, errorCode: compactionFailure(error) };
      }
    };
    const respond = (tx: RuntimeTransaction, chat: { next_message_sequence: number }, compactionId: string) =>
      insertStatusMessage(tx, fence.conversationId, chat.next_message_sequence, compactionId).then(id =>
        finishTurn(tx, fence, id),
      );
    if (command.compactionId) {
      const retryId = command.compactionId;
      const target = await guarded(fence, async tx =>
        z
          .object({ summary: z.unknown().nullable(), prompt: z.string().nullable() })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT s.summary, h.prompt FROM ${table(tx, 'tf_conversation_compactions')} c
        LEFT JOIN ${table(tx, 'tf_conversation_working_summaries')} s ON s.compaction_id=c.id LEFT JOIN ${table(tx, 'tf_conversation_handoffs')} h ON h.compaction_id=c.id
        WHERE c.conversation_id=$1 AND c.id=$2`,
                [fence.conversationId, retryId],
              )
            ).rows[0],
          ),
      );
      if (target === 'stale') return 'stale';
      if (!target) {
        await guarded(fence, tx => failTurn(tx, fence, 'compaction-not-found'));
        return 'stale';
      }
      const parsed = target.summary ? workingSummarySchema.safeParse(target.summary) : null;
      const written = await writeHandoff(
        parsed?.success ? parsed.data : (state.summary?.summary ?? null),
        target.prompt ?? prompt,
      );
      const done = await guarded(fence, async (tx, chat) => {
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_conversation_handoffs')} AS h (compaction_id, conversation_id, status, prompt, text, model_family_id, fallback_from_family_id, error_code, attempts, sources)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9) ON CONFLICT (compaction_id) DO UPDATE SET status=EXCLUDED.status, text=EXCLUDED.text, model_family_id=EXCLUDED.model_family_id,
          fallback_from_family_id=EXCLUDED.fallback_from_family_id, error_code=EXCLUDED.error_code, attempts=h.attempts+1, sources=EXCLUDED.sources, updated_at=clock_timestamp()`,
          [
            retryId,
            fence.conversationId,
            written.status,
            target.prompt ?? prompt,
            written.status === 'completed' ? written.text : null,
            written.status === 'completed' ? written.familyId : null,
            written.status === 'completed' ? written.fallbackFrom : null,
            written.status === 'failed' ? written.errorCode : null,
            JSON.stringify(mergeSources(source.inherited)),
          ],
        );
        await respond(tx, chat, retryId);
      });
      return done === 'stale' ? 'stale' : 'completed';
    }
    const covered = prior.filter(message => latest !== null && message.acceptedSequence < latest && message.text);
    const measure = (messages: ChatMessage[]) =>
      observeChatDetail('context-measure', () =>
        compactor.measure({
          fence,
          model: source.model,
          messages,
          ...(source.project ? { project: source.project } : {}),
          generateTitle: false,
          timeZone: source.timeZone,
        }),
      );
    const render = (summary: WorkingSummary | null, wording: readonly { id: string; text: string }[], from: number) =>
      observeChatDetailSync('render', () => [
        ...(summary ? [summaryBlock(summary, wording)] : []),
        ...prior
          .filter(message => message.acceptedSequence > from && message.text)
          .map(({ role, text }) => ({ role, text })),
      ]);
    const before = await measure(
      render(state.summary?.summary ?? null, state.wording, state.summary?.coveredThrough ?? 0),
    );
    const record: CompactionRecord = {
      id: randomUUID(),
      conversationId: fence.conversationId,
      turnId: fence.turnId,
      trigger: 'manual',
      state: 'unchanged',
      previousId: state.summary?.compactionId ?? null,
      coveredThrough: null,
      policyRevision: policy.revision,
      familyId: null,
      fallbackFrom: null,
      before,
      afterTokens: before?.tokens ?? null,
      triggerPercent: policy.triggerPercent,
      targetPercent: policy.targetPercent,
      errorCode: null,
    };
    let next: { summary: WorkingSummary; coveredThrough: number; wording: { id: string; text: string }[] } | null =
      null;
    if (covered.length && !policy.families.length)
      Object.assign(record, { state: 'failed', errorCode: 'compaction-model-unavailable' });
    else if (covered.length)
      try {
        const result = await summarize(compactor, fence, policy.families, state.summary?.summary ?? null, covered);
        const coveredThrough = Math.max(
          ...covered.map(message => message.acceptedSequence),
          state.summary?.coveredThrough ?? 0,
        );
        next = {
          summary: result.summary,
          coveredThrough,
          wording: protectedWording(state.wording, result.summary, covered),
        };
        const after = await measure(render(next.summary, next.wording, coveredThrough));
        Object.assign(record, {
          state: 'compacted',
          coveredThrough,
          familyId: result.familyId,
          fallbackFrom: result.fallbackFrom,
          afterTokens: after?.tokens ?? null,
        });
      } catch (error) {
        if (rethrown(error)) throw error;
        Object.assign(record, { state: 'failed', errorCode: compactionFailure(error) });
      }
    const handoffSummary = next?.summary ?? state.summary?.summary ?? null;
    const written = handoffSummary || recent.length ? await writeHandoff(handoffSummary, prompt) : null;
    const done = await guarded(fence, async (tx, chat) => {
      await insertCompaction(tx, record);
      if (
        next &&
        !(await replaceWorkingSummary(tx, {
          conversationId: fence.conversationId,
          compactionId: record.id,
          expectedPrevious: record.previousId,
          coveredThrough: next.coveredThrough,
          summary: next.summary,
          protectedMessageIds: next.wording.map(item => item.id),
          sources: source.inherited,
        }))
      )
        throw new Error('conversation-turn-stale');
      if (written)
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_conversation_handoffs')} (compaction_id, conversation_id, status, prompt, text, model_family_id, fallback_from_family_id, error_code, attempts, sources) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9)`,
          [
            record.id,
            fence.conversationId,
            written.status,
            prompt,
            written.status === 'completed' ? written.text : null,
            written.status === 'completed' ? written.familyId : null,
            written.status === 'completed' ? written.fallbackFrom : null,
            written.status === 'failed' ? written.errorCode : null,
            JSON.stringify(mergeSources(source.inherited)),
          ],
        );
      await respond(tx, chat, record.id);
    });
    return done === 'stale' ? 'stale' : 'completed';
  }

  async function complete(value: unknown): Promise<'completed' | 'stale' | 'retry'> {
    const fence = fenceSchema.parse(value);
    const source = await staged('context', () =>
      observeChatDetail('history', () =>
        transaction(fence.workspaceId, async tx => {
          const chat = await root(tx, fence);
          if (!chat) return null;
          const turn = await head(tx, fence.conversationId);
          if (
            !turn ||
            turn.id !== fence.turnId ||
            turn.generation !== fence.generation ||
            turn.attempt_epoch !== fence.epoch ||
            turn.status !== 'processing' ||
            !turn.lease_live
          )
            return null;
          const currentMessage = historySchema.element.parse(
            (
              await tx.client.query(
                `SELECT $2::uuid AS id, 'user' AS role, $3::integer AS "acceptedSequence",
        COALESCE(string_agg(text, '' ORDER BY ordinal) FILTER (WHERE kind = 'text'), '') AS text
        FROM ${table(tx, 'tf_conversation_parts')} WHERE conversation_id = $1 AND message_id = $2`,
                [fence.conversationId, turn.source_message_id, turn.accepted_sequence],
              )
            ).rows[0],
          );
          const managed = Boolean(compactor) && !chat.slack && !chat.context;
          const compaction = managed
            ? await compactionSnapshot(tx, fence.conversationId, fence.turnId, turn.source_message_id)
            : null;
          if (!compaction && (await compactCommand(tx, fence.conversationId, turn.source_message_id))) {
            await failTurn(tx, fence, 'compaction-unavailable');
            return null;
          }
          const compactionPolicy = compaction && compactor ? await compactor.policy(tx) : null;
          const summarySources: SourceDependency[] = [];
          if (compaction?.summary)
            try {
              if (chat.project_id)
                await requireResultSources(tx, chat.requester, fence.conversationId, compaction.summary.sources);
              await requireKnowledgeSources(tx, chat.requester, compaction.summary.sources);
              await requireWorkflowSources(tx, chat.requester, compaction.summary.sources);
              await requireGoogleFileSources(tx, chat.requester, compaction.summary.sources);
              summarySources.push(...compaction.summary.sources);
            } catch (error) {
              if (!(error instanceof AccessDenied)) throw error;
              // An unreadable summary leaves context; the covered messages return so their own checks apply.
              compaction.summary = null;
              compaction.wording = [];
            }
          const planningContext = !chat.slack && !chat.context ? await planning?.context?.(tx, fence) : null;
          const requested = await requestedSkill(tx, fence.conversationId, turn.source_message_id);
          let invoked: InvokedSkill | null = null;
          if (requested) {
            if (!skills) throw new Error('conversation-skills-unavailable');
            invoked = chat.project_id ? null : await skills.resolve(tx, chat.requester, requested);
            if (!invoked) {
              await skillUnavailable(tx, fence);
              return null;
            }
          }
          const planningSkill =
            (turn.planning_mode || planningContext) && invoked?.skillId !== 'planning'
              ? await skills?.resolve(tx, chat.requester, { skillId: 'planning', revision: 'latest' })
              : null;
          if (turn.planning_mode && !planningSkill && invoked?.skillId !== 'planning') {
            await skillUnavailable(tx, fence);
            return null;
          }
          const messages = historySchema
            .parse(
              (
                await tx.client.query(
                  `WITH prior AS (
        SELECT id, source_message_id, response_message_id, accepted_sequence FROM ${table(tx, 'tf_conversation_turns')}
        WHERE conversation_id = $1 AND accepted_sequence < (SELECT accepted_sequence FROM ${table(tx, 'tf_conversation_turns')} WHERE id = $2)
        AND accepted_sequence>=COALESCE((SELECT context_start FROM ${table(tx, 'tf_github_chat_selection')} WHERE conversation_id=$1),1)
        AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_conversation_parts')} c WHERE c.conversation_id=$1 AND c.message_id=source_message_id AND c.kind='compact') AND accepted_sequence>$3
      ), exchanges AS (
        SELECT source_message_id AS message_id, accepted_sequence FROM prior
        UNION ALL SELECT response_message_id, accepted_sequence FROM prior WHERE response_message_id IS NOT NULL
        UNION ALL SELECT p.message_id, t.accepted_sequence FROM prior t
          JOIN ${table(tx, 'tf_internal_conversations')} i ON i.origin_turn_id = t.id AND i.origin_conversation_id = $1
          JOIN ${table(tx, 'tf_internal_publications')} p ON p.internal_id = i.id AND p.conversation_id = $1
        UNION SELECT p.message_id, t.accepted_sequence FROM prior t
          JOIN ${table(tx, 'tf_conversation_requests')} r ON r.turn_id = t.id AND r.conversation_id = $1
          LEFT JOIN ${table(tx, 'tf_conversation_responses')} a ON a.request_id = r.id AND a.conversation_id = $1
          JOIN ${table(tx, 'tf_conversation_parts')} p ON p.conversation_id = $1 AND (p.request_id = r.id OR p.response_id = a.id)
        UNION SELECT p.message_id, t.accepted_sequence FROM prior t
          JOIN ${table(tx, 'tf_conversation_approval_requests')} r ON r.turn_id = t.id AND r.conversation_id = $1
          JOIN ${table(tx, 'tf_conversation_parts')} p ON p.conversation_id = $1 AND p.approval_id = r.id
      ) SELECT m.id, CASE m.author_kind WHEN 'human' THEN 'user' ELSE 'assistant' END AS role, e.accepted_sequence AS "acceptedSequence",
        COALESCE(string_agg(p.text, '' ORDER BY p.ordinal) FILTER (WHERE p.kind = 'text'), '') AS text
        FROM exchanges e JOIN ${table(tx, 'tf_conversation_messages')} m ON m.id = e.message_id AND m.conversation_id = $1
        LEFT JOIN ${table(tx, 'tf_conversation_parts')} p ON p.message_id = m.id
        GROUP BY m.id, e.accepted_sequence ORDER BY e.accepted_sequence DESC, m.sequence DESC LIMIT ${compaction ? 2000 : 39}`,
                  [fence.conversationId, fence.turnId, compaction?.summary?.coveredThrough ?? 0],
                )
              ).rows,
            )
            .reverse();
          messages.push(currentMessage);
          // Only the requester's own references authorize reads for this request; newest first, so the current message wins the file budget.
          const fileReferences = z.array(storedReferenceSchema).parse(
            (
              await tx.client.query(
                `SELECT p.kind,p.message_id AS "messageId",p.file_id AS "fileId",p.google_file AS google FROM ${table(tx, 'tf_conversation_parts')} p
        JOIN ${table(tx, 'tf_conversation_messages')} m ON m.id=p.message_id AND m.conversation_id=p.conversation_id
        WHERE p.conversation_id=$1 AND p.kind IN ('file','google-file') AND p.message_id=ANY($2::uuid[]) AND m.author_kind='human' AND m.membership_id=$3 ORDER BY m.sequence DESC,p.ordinal`,
                [fence.conversationId, messages.map(message => message.id), chat.requester.membershipId],
              )
            ).rows.map(row =>
              row.kind === 'file'
                ? { kind: row.kind, messageId: row.messageId, fileId: row.fileId }
                : { kind: row.kind, messageId: row.messageId, google: row.google },
            ),
          );
          const cleaned = new Set(compaction?.cleaned ?? []);
          const unloadedFiles = [
            ...new Set(
              fileReferences
                .filter(reference => cleaned.has(reference.messageId))
                .map(reference => reference.messageId),
            ),
          ];
          const loadedReferences = fileReferences.filter(reference => !cleaned.has(reference.messageId));
          const timeZone = timeZoneSchema
            .nullable()
            .parse(
              (
                await tx.client.query(
                  `SELECT outcome->>'timeZone' AS timezone FROM ${table(tx, 'tf_conversation_commands')} WHERE conversation_id=$1 AND membership_id=$2 AND operation='send' AND outcome->>'turnId'=$3 LIMIT 1`,
                  [fence.conversationId, chat.requester.membershipId, fence.turnId],
                )
              ).rows[0]?.timezone ?? null,
            );
          const priorTools = z
            .array(toolReceiptSchema)
            .parse(
              (
                await tx.client.query(
                  `SELECT id,tool,status FROM ${table(tx, 'tf_conversation_tool_calls')} WHERE turn_id = $1 ORDER BY sequence`,
                  [fence.turnId],
                )
              ).rows,
            );
          let project: ProjectContext | undefined;
          if (chat.project_id) {
            const stored = (
              await tx.client.query(`SELECT project_context FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$1`, [
                fence.turnId,
              ])
            ).rows[0]?.project_context;
            if (stored) project = await recheckProjectContext(tx, projectContextSchema.parse(stored));
            else
              try {
                project = await captureProjectContext(tx, chat.requester, chat.project_id, currentMessage.text);
                await tx.client.query(
                  `UPDATE ${table(tx, 'tf_conversation_turns')} SET project_context=$2 WHERE id=$1`,
                  [fence.turnId, JSON.stringify(project)],
                );
              } catch (error) {
                if (!(error instanceof RequiredProjectContextTooLarge)) throw error;
                await tx.client.query(
                  `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='failed',lease_until=NULL,retry_at=NULL,error_code='project-context-too-large' WHERE id=$1`,
                  [fence.turnId],
                );
                await interruptToolReceipts(tx, fence.turnId, 'failed');
                await changed(tx, fence, true);
                return null;
              }
          }
          const durable =
            (turn.planning_mode ||
              Boolean(planningContext) ||
              Boolean(resumeMcp) ||
              priorTools.some(call => call.tool === 'present.choice')) &&
            !chat.slack &&
            !chat.context;
          const executionSteps = durable
            ? z
                .array(executionStepSchema)
                .parse(
                  (
                    await tx.client.query(
                      `SELECT s.*,c.tool,c.status FROM ${table(tx, 'tf_conversation_execution_steps')} s JOIN ${table(tx, 'tf_conversation_tool_calls')} c ON c.id=s.call_id WHERE s.turn_id=$1 ORDER BY c.sequence`,
                      [fence.turnId],
                    )
                  ).rows,
                )
            : [];
          for (const step of executionSteps) {
            if (step.tool !== 'present.choice') continue;
            const request = (
              await tx.client.query(
                `SELECT r.prompt,r.answer_schema,r.status,a.answer FROM ${table(tx, 'tf_conversation_requests')} r LEFT JOIN ${table(tx, 'tf_conversation_responses')} a ON a.request_id=r.id WHERE r.turn_id=$1 AND r.producer_id=$2 AND r.internal_id IS NULL`,
                [fence.turnId, step.call_id],
              )
            ).rows[0];
            if (!request || request.status === 'pending') throw new AccessDenied();
            step.output = z.json().parse({
              result: {
                ...request,
                instruction:
                  'This is the human response to your question, not action approval. Continue from it without repeating the question. If cancelled or expired, do not assume a choice.',
              },
              sources: protectedOutputSchema.parse(step.output).sources,
            });
          }
          const googleProposals =
            priorTools.some(call => call.tool === 'google.propose') && !chat.slack && !chat.context
              ? z
                  .array(z.object({ id: uuidSchema, kind: z.string() }))
                  .parse(
                    (
                      await tx.client.query(
                        `SELECT id,operation->>'kind' AS kind FROM ${table(tx, 'tf_google_proposals')} WHERE command_id=ANY($1::uuid[]) AND membership_id=$2 AND user_id=$3 ORDER BY created_at,id`,
                        [
                          priorTools.filter(call => call.tool === 'google.propose').map(call => call.id),
                          chat.requester.membershipId,
                          chat.requester.userId,
                        ],
                      )
                    ).rows,
                  )
              : [];
          const openGoogleProposals =
            chat.slack || chat.context
              ? []
              : z
                  .array(z.object({ id: uuidSchema, kind: z.string(), approved: z.boolean() }))
                  .parse(
                    (
                      await tx.client.query(
                        `SELECT p.id,p.operation->>'kind' AS kind,d.decision IS NOT NULL AS approved
        FROM ${table(tx, 'tf_google_proposals')} p JOIN ${table(tx, 'tf_conversation_tool_calls')} c ON c.id=p.command_id
        LEFT JOIN ${table(tx, 'tf_google_decisions')} d ON d.proposal_id=p.id LEFT JOIN ${table(tx, 'tf_google_receipts')} r ON r.proposal_id=p.id
        WHERE p.membership_id=$3 AND p.user_id=$4 AND p.expires_at>clock_timestamp() AND c.conversation_id=$1 AND c.turn_id<>$2 AND c.tool='google.propose' AND c.status='completed'
        AND r.proposal_id IS NULL AND (d.decision IS NULL OR d.decision='approve') ORDER BY p.created_at DESC,p.id DESC LIMIT 10`,
                        [fence.conversationId, fence.turnId, chat.requester.membershipId, chat.requester.userId],
                      )
                    ).rows,
                  )
                  .reverse();
          const tableProposals =
            chat.slack || chat.context
              ? []
              : z
                  .array(
                    z.object({
                      labels: z.string().nullable(),
                      status: z.enum([
                        'completed',
                        'failed',
                        'rejected',
                        'cancelled',
                        'expired',
                        'approved',
                        'pending',
                      ]),
                    }),
                  )
                  .parse(
                    (
                      await tx.client.query(
                        `SELECT (SELECT string_agg(plan->'after'->>'label', ', ') FROM jsonb_array_elements(p.manifest->'plans') plan) AS labels,
          CASE WHEN (SELECT count(*) FROM ${table(tx, 'tf_table_proposal_receipts')} r WHERE r.proposal_id=p.id AND r.receipt->>'status'='completed')>=jsonb_array_length(p.manifest->'plans') THEN 'completed'
            WHEN EXISTS (SELECT 1 FROM ${table(tx, 'tf_table_proposal_receipts')} r WHERE r.proposal_id=p.id AND r.receipt->>'status'='failed') THEN 'failed'
            WHEN d.decision='reject' THEN 'rejected'
            WHEN (SELECT operation FROM ${table(tx, 'tf_table_proposal_controls')} WHERE proposal_id=p.id ORDER BY sequence DESC LIMIT 1)='cancel' THEN 'cancelled' WHEN p.expires_at<=clock_timestamp() THEN 'expired' WHEN d.decision='approve' THEN 'approved' ELSE 'pending' END AS status
        FROM ${table(tx, 'tf_table_proposals')} p LEFT JOIN ${table(tx, 'tf_table_proposal_decisions')} d ON d.proposal_id=p.id
        WHERE p.conversation_id=$1 AND p.turn_id<>$2 AND p.membership_id=$3 AND p.user_id=$4 ORDER BY p.created_at DESC,p.id DESC LIMIT 10`,
                        [fence.conversationId, fence.turnId, chat.requester.membershipId, chat.requester.userId],
                      )
                    ).rows,
                  )
                  .reverse();
          const inherited: SourceDependency[] =
            chat.context?.kind === 'channel'
              ? chat.context.sources
              : [
                  { kind: 'private-conversation', conversationId: fence.conversationId },
                  ...(chat.context?.sources ?? []),
                ];
          const assistants = messages.filter(message => message.role === 'assistant');
          const rows = z
            .array(z.object({ message_id: uuidSchema, sources: conversationResultSchema.shape.sources }))
            .parse(
              (
                await tx.client.query(
                  `SELECT message_id, sources FROM ${table(tx, 'tf_conversation_results')} WHERE conversation_id=$1 AND message_id=ANY($2::uuid[])`,
                  [fence.conversationId, assistants.map(message => message.id)],
                )
              ).rows,
            );
          for (const row of rows) {
            if (chat.project_id)
              try {
                await requireResultSources(tx, chat.requester, fence.conversationId, row.sources);
              } catch (error) {
                if (!(error instanceof AccessDenied)) throw error;
                const hidden = messages.find(message => message.id === row.message_id);
                if (hidden) hidden.text = '';
                continue;
              }
            // A prior answer whose cited knowledge is no longer eligible leaves model context.
            try {
              await requireKnowledgeSources(tx, chat.requester, row.sources);
              await requireWorkflowSources(tx, chat.requester, row.sources);
              await requireGoogleFileSources(tx, chat.requester, row.sources);
            } catch (error) {
              if (!(error instanceof AccessDenied)) throw error;
              const hidden = messages.find(message => message.id === row.message_id);
              if (hidden) hidden.text = '';
              continue;
            }
            inherited.push(...row.sources);
          }
          if (rows.length !== assistants.length && !chat.project_id) inherited.push({ kind: 'unknown' });
          if (chat.slack) {
            await requireResultSources(tx, chat.requester, fence.conversationId, inherited);
            const started = await tx.client.query(
              `UPDATE ${table(tx, 'tf_slack_dm_events')} SET model_started=true WHERE turn_id=$1 AND NOT model_started RETURNING event_id`,
              [fence.turnId],
            );
            if (!started.rowCount) return null;
          }
          for (const step of executionSteps) {
            inherited.push(...step.sources);
            if (step.output !== null) inherited.push(...protectedOutputSchema.parse(step.output).sources);
          }
          if (invoked) inherited.push(...skillSources(invoked));
          inherited.push(...summarySources);
          await requireGoogleSources(tx, chat.requester, inherited);
          await requireKnowledgeSources(tx, chat.requester, inherited);
          await requireGoogleFileSources(tx, chat.requester, inherited);
          if (durable) await requireMcpSources(tx, chat.requester, fence.conversationId, inherited);
          return {
            model: turn.responder === 'reverse-text-v1' ? defaultConversationModel : turn.responder,
            currentMessage,
            messages,
            fileReferences: loadedReferences,
            unloadedFiles,
            compaction,
            compactionPolicy,
            requester: chat.requester,
            timeZone,
            priorTools,
            googleProposals,
            openGoogleProposals,
            tableProposals,
            inherited,
            invoked,
            durable,
            executionSteps,
            interactiveChat: !chat.slack && !chat.context,
            planningMode: turn.planning_mode,
            planningSkill,
            planningContext,
            generateTitle: turn.accepted_sequence === 1 && !chat.title_manual && !chat.slack && !chat.context,
            titleRevision: chat.title_revision,
            project,
          };
        }),
      ),
    );
    if (!source) return 'stale';
    if (source.compaction?.command && compactor && source.compactionPolicy) {
      const {
        compaction: { command },
        compactionPolicy,
      } = source;
      return staged('compaction', () => compactTurn(fence, source, command, compactionPolicy, compactor));
    }
    const durable = source.durable;
    const interactiveChat = source.interactiveChat;
    const inheritedSources = source.inherited;
    let text = 'Attachment received.';
    let title: string | undefined;
    let titleSource: ConversationResult['titleSource'];
    let sources: SourceDependency[] = [{ kind: 'unknown' }];
    let replied = false;
    const fileSources: FileSource[] = [];
    let fileContext = (_messageId: string) => '';
    if (
      source.priorTools.length &&
      (!source.durable ||
        source.executionSteps.length !== source.priorTools.length ||
        source.executionSteps.some(step => step.output === null))
    )
      text = [
        'The reply was interrupted after these tool calls. I did not repeat them.',
        ...source.priorTools.map(call => `- ${call.tool}: ${call.status}`),
        ...source.googleProposals.map(
          proposal =>
            `Google proposal ${proposal.id} (${proposal.kind}) was saved. Review its current status and exact payload in Integrations > Google > Approvals before approving. No Google write is confirmed by this recovery message.`,
        ),
        ...(source.googleProposals.length
          ? []
          : [
              'Tool statuses describe the calls, not confirmation of a write. Check current records and approvals before requesting another action.',
            ]),
      ].join('\n');
    else if (
      source.currentMessage.text ||
      source.fileReferences.some(reference => reference.messageId === source.currentMessage.id) ||
      source.invoked
    ) {
      if (!reply) throw new Error('conversation-model-unavailable');
      if (source.fileReferences.length) {
        const read = await staged('files', () =>
          readReferencedFiles({
            workspaceId: fence.workspaceId,
            conversationId: fence.conversationId,
            actor: source.requester,
            references: source.fileReferences,
            files,
            google,
            authorize: check =>
              transaction(fence.workspaceId, async tx => {
                const chat = await root(tx, fence);
                const turn = await head(tx, fence.conversationId);
                if (
                  !chat ||
                  !turn ||
                  turn.id !== fence.turnId ||
                  turn.generation !== fence.generation ||
                  turn.attempt_epoch !== fence.epoch ||
                  turn.status !== 'processing' ||
                  !turn.lease_live
                )
                  throw new Error('conversation-turn-stale');
                await check(tx);
                await tx.client.query(
                  `UPDATE ${table(tx, 'tf_conversation_turns')} SET lease_until = clock_timestamp() + interval '60 seconds' WHERE id = $1 AND status='processing'`,
                  [fence.turnId],
                );
              }),
          }),
        );
        fileSources.push(...read.sources);
        fileContext = read.context;
      }
      let calls = source.priorTools.length;
      const currentPersonalMemory = () =>
        staged('memory', () =>
          transaction(fence.workspaceId, async tx => {
            const chat = await root(tx, fence);
            const turn = await head(tx, fence.conversationId);
            if (
              !chat ||
              !turn ||
              turn.id !== fence.turnId ||
              turn.generation !== fence.generation ||
              turn.attempt_epoch !== fence.epoch ||
              turn.status !== 'processing' ||
              !turn.lease_live
            )
              throw new AccessDenied();
            if (chat.project_id || chat.slack || chat.context) return undefined;
            await requireGitHubSources(tx, chat.requester, inheritedSources);
            await requireGoogleSources(tx, chat.requester, inheritedSources);
            await requireKnowledgeSources(tx, chat.requester, inheritedSources);
            await requireGoogleFileSources(tx, chat.requester, inheritedSources);
            await requireFileSources(tx, chat.requester, fileSources);
            await requireMcpSources(tx, chat.requester, fence.conversationId, inheritedSources);
            const memory = await readPersonalMemory(tx, chat.requester);
            if (memory.content)
              inheritedSources.push({ kind: 'personal-memory', membershipId: chat.requester.membershipId });
            return memory;
          }),
        );
      const runTool: Parameters<ConversationReply>[0]['executeTool'] = async (
        name,
        external,
        operation,
        dependencies = [],
        call,
        activity,
      ) => {
        // Keep the claim alive through a full knowledge call and its final receipt.
        const leaseMs = name.startsWith('knowledge.') ? defaultCallTimeoutMs + 60_000 : 60_000;
        const captureOutput =
          durable ||
          name === 'present.choice' ||
          ['rows.list', 'rows.create', 'rows.create.batch', 'rows.update'].includes(name) ||
          (interactiveChat &&
            (isCalendarReadCall(name, call) ||
              name === 'web.fetch' ||
              name === 'web.search' ||
              name === 'files.create'));
        const currentSources = conversationResultSchema.shape.sources.parse(dependencies);
        if (++calls > chatToolCallLimit || !/^[a-z][a-z0-9.]{0,63}$/.test(name))
          throw new Error('conversation-tool-unavailable');
        const callId = randomUUID();
        const toolStarted = performance.now();
        let sequence = calls;
        let sequenceReserved = false;
        async function guarded<T>(action: (tx: RuntimeTransaction, context: ConversationToolContext) => Promise<T>) {
          return transaction(fence.workspaceId, async tx => {
            const chat = await root(tx, fence);
            const turn = await head(tx, fence.conversationId);
            if (
              !chat ||
              !turn ||
              turn.id !== fence.turnId ||
              turn.generation !== fence.generation ||
              turn.attempt_epoch !== fence.epoch ||
              turn.status !== 'processing' ||
              !turn.lease_live
            )
              throw new AccessDenied();
            if (chat.slack) await requireResultSources(tx, chat.requester, fence.conversationId, currentSources);
            await requireGitHubSources(tx, chat.requester, [...inheritedSources, ...currentSources]);
            await requireGoogleSources(tx, chat.requester, [...inheritedSources, ...currentSources]);
            await requireKnowledgeSources(tx, chat.requester, [...inheritedSources, ...currentSources]);
            await requireGoogleFileSources(tx, chat.requester, inheritedSources);
            await requireFileSources(tx, chat.requester, fileSources);
            await requireMcpSources(tx, chat.requester, fence.conversationId, [...inheritedSources, ...currentSources]);
            if (chat.context && externalContext) await externalContext(tx, fence, currentSources);
            if (!sequenceReserved) {
              sequence = Number(
                (
                  await tx.client.query(
                    `SELECT COALESCE(max(sequence),0)+1 AS sequence FROM ${table(tx, 'tf_conversation_tool_calls')} WHERE turn_id=$1`,
                    [fence.turnId],
                  )
                ).rows[0]?.sequence,
              );
              sequenceReserved = true;
            }
            if (
              (
                await tx.client.query(
                  `SELECT 1 FROM ${table(tx, 'tf_conversation_tool_calls')} WHERE turn_id = $1 AND sequence = $2 AND id <> $3`,
                  [fence.turnId, sequence, callId],
                )
              ).rowCount
            )
              throw new AccessDenied();
            const bound: ConversationRuntime = {
              transaction: async (workspace, range, action) => {
                if (
                  workspace !== fence.workspaceId ||
                  tx.commonVersion < range.minimum ||
                  tx.commonVersion > range.maximum
                )
                  throw new AccessDenied();
                if (chat.slack) await requireResultSources(tx, chat.requester, fence.conversationId, currentSources);
                if (chat.context && externalContext) await externalContext(tx, fence, currentSources);
                return action(tx);
              },
            };
            const result = await action(tx, {
              runtime: bound,
              workspaceId: fence.workspaceId,
              actor: chat.requester,
              callId,
              origin: {
                conversationId: fence.conversationId,
                turnId: fence.turnId,
                generation: fence.generation,
                epoch: fence.epoch,
                sources: mergeSources([...inheritedSources, ...currentSources]),
                files: fileSources,
              },
            });
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_conversation_turns')} SET lease_until = clock_timestamp() + $2*interval '1 millisecond' WHERE id = $1 AND status='processing'`,
              [fence.turnId, leaseMs],
            );
            return result;
          });
        }
        async function receipt(
          tx: AuthorizationTransaction & { commonVersion: number },
          status: 'running' | 'completed' | 'blocked' | 'failed',
        ) {
          const label = [
            ...(
              await storedToolPresentation(
                tx,
                await turnRequester(tx, fence.conversationId, fence.turnId),
                name,
                call,
                activity,
                callId,
              )
            ).label,
          ]
            .slice(0, 120)
            .join('');
          const saved = await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_tool_calls')} (id, conversation_id, turn_id, tool, status, sequence${label === undefined ? '' : ', activity'}) VALUES ($1,$2,$3,$4,$5,$6${label === undefined ? '' : ',$7'}) ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status WHERE ${table(tx, 'tf_conversation_tool_calls')}.status = 'running' RETURNING id`,
            [
              callId,
              fence.conversationId,
              fence.turnId,
              name,
              status,
              sequence,
              ...(label === undefined ? [] : [label]),
            ],
          );
          if (!saved.rowCount) throw new Error('tool-receipt-terminal');
          await notifyConversationTool(tx, {
            workspaceId: fence.workspaceId,
            conversationId: fence.conversationId,
            turnId: fence.turnId,
            generation: fence.generation,
            epoch: fence.epoch,
            id: callId,
            tool: name,
            sequence,
            status,
            presentation: toolPresentation(name),
          });
          await changed(tx, fence);
          if ((captureOutput || interactiveChat) && call !== undefined)
            await tx.client.query(
              `INSERT INTO ${table(tx, 'tf_conversation_execution_steps')} (call_id,turn_id,call,sources) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
              [
                callId,
                fence.turnId,
                JSON.stringify(call),
                JSON.stringify(mergeSources([...inheritedSources, ...currentSources])),
              ],
            );
        }
        async function saveOutput(tx: AuthorizationTransaction, output: unknown) {
          const protectedOutput = protectedOutputSchema.safeParse(output);
          if (protectedOutput.success) {
            const requester = await turnRequester(tx, fence.conversationId, fence.turnId);
            await requireGoogleSources(tx, requester, protectedOutput.data.sources);
            await requireKnowledgeSources(tx, requester, protectedOutput.data.sources);
            await requireWorkflowSources(tx, requester, protectedOutput.data.sources);
            inheritedSources.push(
              ...protectedOutput.data.sources.filter(
                source =>
                  source.kind === 'google-integration' ||
                  source.kind === 'knowledge-document' ||
                  source.kind === 'workflow-definition' ||
                  source.kind === 'workflow-provider',
              ),
            );
          }
          // Keep native receipts for a later choice pause without changing legacy raw callbacks into replayable tools.
          if ((captureOutput || (interactiveChat && protectedOutput.success)) && call !== undefined) {
            const parsed = protectedOutputSchema.parse(output);
            if (Buffer.byteLength(JSON.stringify(parsed)) > 2 * 1024 * 1024) throw new Error('tool-result-limit');
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_conversation_execution_steps')} SET output=$2 WHERE call_id=$1 AND output IS NULL`,
              [callId, JSON.stringify(parsed)],
            );
          }
        }
        try {
          if (source.planningMode && !planning?.allowsResearch(name, call)) {
            const output = {
              result: {
                error: 'plan-only',
                instruction:
                  'Plan mode permits research and a plan-only draft, not business writes, business drafts, activation, or dispatch. Save the plan and wait for an explicit Start action.',
              },
              sources: [],
            };
            await guarded(async tx => {
              await receipt(tx, 'blocked');
              await saveOutput(tx, output);
            });
            return output;
          }
          if (name === 'present.choice') {
            if (!interactiveChat || external) throw new AccessDenied();
            const choice = presentChoiceSchema.parse(call);
            await guarded(async (tx, context) => {
              if (
                source.project &&
                !(await projectAudienceCanRead(tx, source.project.projectId, fence.conversationId, [
                  ...context.origin.sources,
                  ...fileSources,
                ]))
              )
                throw new AccessDenied();
              await receipt(tx, 'running');
              const request = await createConversationRequests(context.runtime).createForChat(fence, {
                producerId: callId,
                prompt: choice.prompt,
                answerSchema: { kind: 'choices', choices: choice.choices, multiple: false, allowText: true },
              });
              await receipt(tx, 'completed');
              await saveOutput(tx, {
                result: request,
                sources: mergeSources([...context.origin.sources, ...fileSources]),
              });
            });
            throw new ExternalActionWaiting();
          }
          if (external) {
            const context = await guarded(async (tx, context) => {
              await receipt(tx, 'running');
              await planning?.authorizeTool?.(tx, fence, name, callId);
              const guardedRuntime: ConversationRuntime = {
                transaction: async (workspace, range, action) =>
                  runtime.transaction(workspace, range, async current => {
                    if (workspace !== fence.workspaceId) throw new AccessDenied();
                    await lockAuthorization(current);
                    const chat = await root(
                      current,
                      fence,
                      name === 'github.personal.execute' ? 'approved-batch' : 'conversation',
                    );
                    if (!chat) throw new AccessDenied();
                    await renewConversationReplyLease(current, fence, leaseMs);
                    if (chat.slack)
                      await requireResultSources(current, chat.requester, fence.conversationId, currentSources);
                    // Batch execution rechecks its immutable sources and own receipts. Chat admission and result delivery still require exact snapshots.
                    if (name !== 'github.personal.execute')
                      await requireGitHubSources(current, chat.requester, [...inheritedSources, ...currentSources]);
                    await requireGoogleSources(current, chat.requester, [...inheritedSources, ...currentSources]);
                    await requireKnowledgeSources(current, chat.requester, [...inheritedSources, ...currentSources]);
                    await requireGoogleFileSources(current, chat.requester, [...inheritedSources, ...fileSources]);
                    await requireMcpSources(current, chat.requester, fence.conversationId, [
                      ...inheritedSources,
                      ...currentSources,
                    ]);
                    if (chat.context && externalContext) await externalContext(current, fence, currentSources);
                    await planning?.authorizeTool?.(current, fence, name, callId);
                    return action(current);
                  }),
              };
              return { ...context, runtime: guardedRuntime };
            });
            const result = await operation(context);
            const mcp = mcpWaitSchema.safeParse(result);
            if (mcp.success) {
              if (!source.durable || mcp.data.result.actionId !== callId || name !== 'mcp.call')
                throw new AccessDenied();
              await guarded(async tx => {
                await tx.client.query(
                  `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='waiting',lease_until=NULL,error_code='mcp-action-waiting' WHERE id=$1`,
                  [fence.turnId],
                );
                await changed(tx, fence, true);
              });
              throw new ExternalActionWaiting();
            }
            const slack = z
              .object({ result: z.object({ provider: z.literal('slack'), status: z.string() }) })
              .safeParse(result);
            if (slack.success && ['pending', 'retry', 'sending', 'approved'].includes(slack.data.result.status)) {
              await guarded(async tx => {
                await tx.client.query(
                  `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='waiting',lease_until=NULL,error_code='slack-action-waiting' WHERE id=$1`,
                  [fence.turnId],
                );
                await changed(tx, fence, true);
              });
              throw new ExternalActionWaiting();
            }
            return await guarded(async tx => {
              await receipt(tx, 'completed');
              await saveOutput(tx, result);
              return result;
            });
          }
          await guarded(tx => receipt(tx, 'running'));
          return await guarded(async (tx, context) => {
            await planning?.authorizeTool?.(tx, fence, name, callId);
            const result = await operation(context);
            await receipt(tx, 'completed');
            await saveOutput(tx, result);
            return result;
          });
        } catch (error) {
          if (error instanceof ExternalActionWaiting) throw error;
          const planningFailure = planning?.failure?.(error);
          if (name === 'mcp.call' && durable && !planningFailure) {
            await guarded(async tx => {
              await tx.client.query(
                `UPDATE ${table(tx, 'tf_conversation_turns')} SET status=$2,lease_until=NULL,error_code=$3 WHERE id=$1`,
                [
                  fence.turnId,
                  error instanceof AccessDenied ? 'blocked' : 'waiting',
                  error instanceof AccessDenied ? 'requester-unavailable' : 'mcp-action-waiting',
                ],
              );
              await changed(tx, fence, true);
            });
            throw new ExternalActionWaiting();
          }
          const status = error instanceof AccessDenied || planningFailure ? 'blocked' : 'failed';
          const recorded = await staged('tool-recovery', () =>
            guarded(async tx => {
              if (
                (
                  await tx.client.query(
                    `SELECT 1 FROM ${table(tx, 'tf_conversation_tool_calls')} WHERE id = $1 AND status = 'completed'`,
                    [callId],
                  )
                ).rowCount
              )
                throw new Error('tool-outcome-already-committed');
              await receipt(tx, status);
              return true;
            }).catch(async (denied: unknown) => {
              if (!(denied instanceof AccessDenied)) throw denied;
              // The source check that denied the tool also denies this guard. The terminal status discloses no tool data, so record
              // it under the turn fence alone and return the denial to the model. Each later model step and delivery recheck all sources.
              await transaction(fence.workspaceId, async tx => {
                const chat = await root(tx, fence);
                const turn = await head(tx, fence.conversationId);
                if (
                  !chat ||
                  !turn ||
                  turn.id !== fence.turnId ||
                  turn.generation !== fence.generation ||
                  turn.attempt_epoch !== fence.epoch ||
                  turn.status !== 'processing' ||
                  !turn.lease_live
                )
                  throw denied;
                if (
                  (
                    await tx.client.query(
                      `UPDATE ${table(tx, 'tf_conversation_tool_calls')} SET status = $2 WHERE id = $1 AND status = 'running'`,
                      [callId, status],
                    )
                  ).rowCount
                )
                  await changed(tx, fence);
              });
              return false;
            }),
          );
          // Dispatch failures were already logged by observeTool; this logs only failures in the receipt and source checks around it.
          if (!toolFailureLogged(error))
            log('error', 'tool', 'call_failed', {
              tool: name,
              runtime: 'chat',
              operation: name,
              outcome: status === 'blocked' ? 'blocked' : 'error',
              'error.type': errorType(error),
              ...(error instanceof z.ZodError
                ? { 'error.issues': error.issues.map(issue => `${issue.path.join('.')}:${issue.code}`) }
                : {}),
            });
          const output = {
            result: planningFailure
              ? { error: planningFailure.code, instruction: planningFailure.instruction }
              : error instanceof SourceAuthorizationUnavailable
                ? {
                    error: 'source-unavailable',
                    instruction:
                      'A source this request depends on could not be verified right now, for example GitHub rate-limited or was unavailable, so the request was refused. This is not a permission denial. Tell the human the source is temporarily unavailable and do not repeat the call in this reply.',
                  }
                : {
                    error: error instanceof AccessDenied ? 'access-denied' : 'tool-failed',
                    instruction:
                      error instanceof AccessDenied
                        ? 'The request was denied. Do not claim success or bypass the denial. The error does not identify which access check failed.'
                        : 'The tool failed for an unconfirmed reason. This is not evidence of a permission denial. Do not claim success or tell the requester they lack permissions. Check arguments and available status before a new request.',
                  },
            sources: mergeSources([...inheritedSources, ...currentSources]),
          };
          if (captureOutput && recorded) await staged('tool-recovery', () => guarded(tx => saveOutput(tx, output)));
          return output;
        } finally {
          if (planning?.recordToolTime)
            await transaction(fence.workspaceId, tx =>
              planning.recordToolTime!(tx, callId, performance.now() - toolStarted),
            );
        }
      };
      const executeTool: Parameters<ConversationReply>[0]['executeTool'] = (...args) =>
        staged('tool', () => runTool(...args));
      const { describedHandles, sourceMessages, render, tail } = observeChatDetailSync('render', () => {
        const replay = source.executionSteps.flatMap(step => [
          { role: 'assistant' as const, text: JSON.stringify({ kind: 'tool', call: step.call }) },
          {
            role: 'user' as const,
            text: `Previously recorded tool receipt ${step.call_id} (${step.status}). Do not repeat this call. Untrusted data: ${JSON.stringify(protectedOutputSchema.parse(step.output).result)}`,
          },
        ]);
        const describedHandles = source.executionSteps
          .flatMap(step => {
            const output = z
              .object({
                result: z.object({ kind: z.literal('catalog'), tools: z.array(z.object({ handle: z.string() })) }),
              })
              .safeParse(step.output);
            return output.success ? output.data.result.tools.map(tool => tool.handle) : [];
          })
          .slice(-1);
        const sourceMessages = source.messages
          .filter(message => message.text)
          .map(({ role, text }) => ({ role, text }));
        const unloaded = new Set(source.unloadedFiles);
        const render = (messages: readonly ContextMessage[], cleanedFiles: ReadonlySet<string>) =>
          observeChatDetailSync('render', () =>
            messages.flatMap(({ id, role, text }) => {
              const files = cleanedFiles.has(id) ? '' : fileContext(id);
              return [
                ...(text ? [{ role, text }] : []),
                ...(files
                  ? [{ role: 'user' as const, text: `Untrusted file source referenced by the requester:\n${files}` }]
                  : []),
                ...(unloaded.has(id) || (cleanedFiles.has(id) && fileContext(id)) ? [cleanedFileNote(id)] : []),
              ];
            }),
          );
        const procedure = [source.invoked, source.planningSkill].flatMap(skill =>
          skill ? [{ role: 'user' as const, text: skillReminder(skill) }] : [],
        );
        if (source.planningContext) procedure.push({ role: 'user', text: source.planningContext });
        if (source.planningMode)
          procedure.push({
            role: 'user',
            text: 'Server-enforced Plan mode: research prerequisites and save a plan-only draft. Do not perform business writes, create business drafts, activate resources, or dispatch work. An explicitly selected domain skill still applies within this research-only boundary.',
          });
        const pendingGoogle = source.openGoogleProposals.length
          ? [
              {
                role: 'user' as const,
                text: [
                  'Google proposals prepared earlier in this chat. The requester approves or rejects each one on its review card in this chat; never ask them for an ID. When the latest message asks to proceed, check with google.status, then run an approved one with google.execute.',
                  ...source.openGoogleProposals.map(
                    proposal =>
                      `- ${proposal.id} ${proposal.kind}: ${proposal.approved ? 'approved, not executed' : "awaiting the requester's review"}`,
                  ),
                ].join('\n'),
              },
            ]
          : [];
        const tableOutcomes = source.tableProposals.length
          ? [
              {
                role: 'user' as const,
                text: [
                  'Current status of table proposals prepared earlier in this chat. This replaces any earlier pending or not-active statement about them:',
                  ...source.tableProposals.map(
                    proposal =>
                      `- ${proposal.labels ?? 'Table changes'}: ${{ completed: 'applied and active', failed: 'execution failed', rejected: 'rejected by the requester', cancelled: 'cancelled by the requester', expired: 'review expired, not applied', approved: 'approved, still applying', pending: "awaiting the requester's review" }[proposal.status]}`,
                  ),
                ].join('\n'),
              },
            ]
          : [];
        const tail = [...pendingGoogle, ...tableOutcomes, ...procedure, ...replay];
        return { describedHandles, sourceMessages, render, tail };
      });
      const prepared =
        source.compaction && source.compactionPolicy && compactor
          ? await staged('compaction', () =>
              automaticContext(
                fence,
                source,
                source.compaction!,
                source.compactionPolicy!,
                compactor,
                render,
                id => Boolean(fileContext(id)),
                tail,
              ),
            )
          : observeChatDetailSync('render', () => [
              ...(source.compaction?.summary
                ? [summaryBlock(source.compaction.summary.summary, source.compaction.wording)]
                : []),
              ...render(source.messages, new Set()),
              ...tail,
            ]);
      if (prepared === 'stale') return 'stale';
      const answer = conversationResult(
        await staged('model', () =>
          reply({
            model: source.model,
            messages: prepared,
            sourceMessages,
            executeTool,
            readPersonalMemory: currentPersonalMemory,
            fence,
            generateTitle: source.generateTitle,
            timeZone: source.timeZone,
            priorCalls: source.priorTools.length,
            priorToolCalls: source.executionSteps.map(step => step.call),
            earlierMessages: prepared.some(message => message.text.startsWith(summaryHeading)),
            retainedSources: mergeSources(inheritedSources),
            describedHandles,
            ...(source.project ? { project: source.project } : {}),
          }),
        ),
      );
      text = answer.text || 'The model returned an empty reply.';
      title = source.generateTitle ? answer.title : undefined;
      titleSource = answer.titleSource;
      sources = answer.sources;
      replied = true;
    }
    return staged('delivery', () =>
      transaction(fence.workspaceId, async tx => {
        const chat = await root(tx, fence);
        if (!chat) return 'stale';
        const turn = await head(tx, fence.conversationId);
        if (
          !turn ||
          turn.id !== fence.turnId ||
          turn.generation !== fence.generation ||
          turn.attempt_epoch !== fence.epoch ||
          turn.status !== 'processing' ||
          !turn.lease_live
        )
          return 'stale';
        const used = replied ? source.invoked : null;
        if (used && (chat.project_id || !(await skills?.resolve(tx, chat.requester, used)))) {
          await skillUnavailable(tx, fence);
          return 'stale';
        }
        if (chat.slack) await requireResultSources(tx, chat.requester, fence.conversationId, sources);
        await requireGitHubSources(tx, chat.requester, [...source.inherited, ...sources]);
        await requireGoogleSources(tx, chat.requester, [...source.inherited, ...sources]);
        await requireKnowledgeSources(tx, chat.requester, [...source.inherited, ...sources]);
        await requireGoogleFileSources(tx, chat.requester, source.inherited);
        await requireFileSources(tx, chat.requester, fileSources);
        await requireMcpSources(tx, chat.requester, fence.conversationId, [...source.inherited, ...sources]);
        if (chat.context && externalContext) await externalContext(tx, fence, sources);
        if (chat.project_id && !replied) sources = [];
        if (chat.project_id && replied && source.project)
          sources = [
            ...sources,
            ...(await projectPassageFileSources(
              tx,
              chat.project_id,
              fence.conversationId,
              chat.requester.membershipId,
              source.project.files,
            )),
          ];
        sources = [...sources, ...fileSources];
        if (
          chat.project_id &&
          !(await projectAudienceCanRead(tx, chat.project_id, fence.conversationId, [...source.inherited, ...sources]))
        ) {
          text = privateReply;
          title = undefined;
          sources = [];
        }
        if (!chat.slack && !chat.context && !source.planningMode && replied) {
          const next = await planning?.finish?.(tx, fence);
          if (next?.kind === 'continue') {
            await changed(tx, fence);
            return 'retry';
          }
          if (next?.kind === 'complete' && next.text) text = next.text;
        }
        const result = replyParts(text);
        const messageId = randomUUID();
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_conversation_messages')} (id, conversation_id, sequence, author_kind) VALUES ($1,$2,$3,'assistant')`,
          [messageId, fence.conversationId, chat.next_message_sequence],
        );
        let ordinal = 0;
        if (used) await insertSkillPart(tx, fence.conversationId, messageId, ordinal++, 'skill-use', used);
        if (replied && source.planningSkill && !used)
          await insertSkillPart(tx, fence.conversationId, messageId, ordinal++, 'skill-use', source.planningSkill);
        for (const text of result) {
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_parts')} (conversation_id, message_id, ordinal, kind, text) VALUES ($1,$2,$3,'text',$4)`,
            [fence.conversationId, messageId, ordinal++, text],
          );
        }
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_conversation_results')} (conversation_id, turn_id, message_id, sources) VALUES ($1,$2,$3,$4)`,
          [
            fence.conversationId,
            fence.turnId,
            messageId,
            JSON.stringify(mergeSources([...source.inherited, ...sources])),
          ],
        );
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_turns')} SET status = 'completed', response_message_id = $2, lease_until = NULL, retry_at = NULL, error_code = NULL WHERE id = $1`,
          [fence.turnId, messageId],
        );
        await interruptToolReceipts(tx, fence.turnId, 'failed');
        await changed(tx, fence, true);
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversations')} SET next_message_sequence = next_message_sequence + 1, activity_at = clock_timestamp() WHERE id = $1`,
          [fence.conversationId],
        );
        await recordConversationActivity(tx, fence.conversationId);
        if (
          title &&
          (titleSource === 'user-message' ||
            ![...source.inherited, ...sources].some(
              item =>
                item.kind === 'github-personal' ||
                (item.kind === 'github-source' && item.investigation) ||
                item.kind === 'google-integration' ||
                item.kind === 'mcp-integration' ||
                item.kind === 'tulipfarm-file' ||
                item.kind === 'google-file' ||
                item.kind === 'knowledge-document',
            ))
        )
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_conversations')} SET title = $2, title_revision = title_revision + 1 WHERE id = $1 AND NOT title_manual AND title_revision = $3`,
            [fence.conversationId, title, source.titleRevision],
          );
        const next = await head(tx, fence.conversationId);
        if (next)
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_outbox')} (turn_id, conversation_id, generation) VALUES ($1,$2,$3) ON CONFLICT (turn_id, generation) DO UPDATE SET next_attempt_at = clock_timestamp(), dispatched_at = NULL`,
            [next.id, fence.conversationId, next.generation],
          );
        return 'completed';
      }),
    );
  }

  // A denial is deterministic, so retrying would repeat the same checks; an unverifiable source may recover and retries.
  async function fail(
    value: unknown,
    creditFailure = false,
    modelFailure?: z.infer<typeof modelFailureSchema>,
    denied = false,
    planningFailure?: 'plan-budget',
  ): Promise<'retry' | 'failed' | 'stale'> {
    const fence = fenceSchema.parse(value);
    return transaction(fence.workspaceId, async tx => {
      if (!(await root(tx, fence))) return 'stale';
      const turn = await head(tx, fence.conversationId);
      if (
        !turn ||
        turn.id !== fence.turnId ||
        turn.generation !== fence.generation ||
        turn.attempt_epoch !== fence.epoch ||
        turn.status !== 'processing'
      )
        return 'stale';
      await interruptToolReceipts(tx, fence.turnId, 'failed');
      if (!turn.lease_live) return 'stale';
      const exhausted =
        creditFailure ||
        denied ||
        planningFailure !== undefined ||
        modelFailure === 'model-incomplete-response' ||
        turn.attempts >= 5;
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_conversation_turns')} SET status = $2, lease_until = NULL, error_code = $3, generation = generation + 1, retry_at = CASE WHEN $2 = 'queued' THEN clock_timestamp() + $4 * interval '1 second' ELSE NULL END WHERE id = $1`,
        [
          turn.id,
          exhausted ? 'failed' : 'queued',
          planningFailure ??
            (creditFailure
              ? 'credits-exhausted'
              : (modelFailure ?? (denied ? 'access-denied' : exhausted ? 'attempts-exhausted' : 'transient-failure'))),
          Math.min(30, 2 ** turn.attempts),
        ],
      );
      await changed(tx, fence, exhausted);
      if (!exhausted)
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_conversation_outbox')} (turn_id, conversation_id, generation, next_attempt_at) SELECT id, conversation_id, generation, retry_at FROM ${table(tx, 'tf_conversation_turns')} WHERE id = $1`,
          [turn.id],
        );
      return exhausted ? 'failed' : 'retry';
    });
  }

  async function process(value: unknown): Promise<'completed' | 'idle' | 'retry' | 'failed' | 'stale'> {
    return withChatMeasurements(() =>
      observeChatDetail('turn', async (): Promise<'completed' | 'idle' | 'retry' | 'failed' | 'stale'> => {
        let fence: ReplyFence | null = null;
        let stage: ReplyStage = 'resume';
        try {
          const work = replyWorkSchema.parse(value);
          const resumed = await observeChatDetail(
            'resume',
            async (): Promise<'idle' | { finish: () => Promise<'completed' | 'stale' | 'retry'> } | undefined> => {
              if (resumeMcp) {
                const pending = await transaction(work.workspaceId, async tx => {
                  const chat = await root(tx, work);
                  if (!chat || chat.slack || chat.context) return null;
                  const turn = await head(tx, work.conversationId);
                  if (
                    !turn ||
                    turn.id !== work.turnId ||
                    turn.generation !== work.generation ||
                    turn.status !== 'waiting'
                  )
                    return null;
                  return executionStepSchema
                    .optional()
                    .parse(
                      (
                        await tx.client.query(
                          `SELECT s.*,c.tool,c.status FROM ${table(tx, 'tf_conversation_execution_steps')} s JOIN ${table(tx, 'tf_conversation_tool_calls')} c ON c.id=s.call_id WHERE s.turn_id=$1 AND c.tool='mcp.call' AND c.status='running'`,
                          [work.turnId],
                        )
                      ).rows[0],
                    );
                });
                if (pending) {
                  const actor = await transaction(work.workspaceId, tx =>
                    turnRequester(tx, work.conversationId, work.turnId),
                  );
                  const response = await resumeMcp(
                    {
                      runtime,
                      workspaceId: work.workspaceId,
                      actor,
                      callId: pending.call_id,
                      origin: { conversationId: work.conversationId, turnId: work.turnId, sources: pending.sources },
                    },
                    pending.call,
                  );
                  if (response.result.kind === 'waiting') return 'idle';
                  await transaction(work.workspaceId, async tx => {
                    const chat = await root(tx, work);
                    const turn = await head(tx, work.conversationId);
                    if (
                      !chat ||
                      !turn ||
                      turn.id !== work.turnId ||
                      turn.generation !== work.generation ||
                      turn.status !== 'waiting'
                    )
                      throw new AccessDenied();
                    await requireMcpSources(tx, actor, work.conversationId, [...pending.sources, ...response.sources]);
                    await tx.client.query(
                      `UPDATE ${table(tx, 'tf_conversation_execution_steps')} SET output=$2 WHERE call_id=$1 AND output IS NULL`,
                      [pending.call_id, JSON.stringify(response)],
                    );
                    await tx.client.query(
                      `UPDATE ${table(tx, 'tf_conversation_tool_calls')} SET status='completed' WHERE id=$1 AND status='running'`,
                      [pending.call_id],
                    );
                    await tx.client.query(
                      `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='queued',error_code=NULL,attempts=0,retry_at=NULL WHERE id=$1`,
                      [work.turnId],
                    );
                    await changed(tx, work);
                  });
                }
              }
              const waiting = await transaction(work.workspaceId, async tx => {
                if (!(await root(tx, work))) return false;
                return Boolean(
                  (
                    await tx.client.query(
                      `SELECT 1 FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$1 AND generation=$2 AND status='waiting' AND error_code='slack-action-waiting'`,
                      [work.turnId, work.generation],
                    )
                  ).rowCount,
                );
              });
              if (waiting) {
                if (!resumeExternal) return 'idle';
                const action = await resumeExternal(work.workspaceId, work.turnId);
                if (['pending', 'retry', 'sending', 'approved'].includes(action.status)) return 'idle';
                return {
                  finish: () =>
                    transaction(work.workspaceId, async tx => {
                      const chat = await root(tx, work);
                      if (!chat) return 'stale';
                      const turn = await head(tx, work.conversationId);
                      if (
                        !turn ||
                        turn.id !== work.turnId ||
                        turn.status !== 'waiting' ||
                        turn.generation !== work.generation
                      )
                        return 'stale';
                      await tx.client.query(
                        `UPDATE ${table(tx, 'tf_conversation_tool_calls')} SET status=$2 WHERE id=$1 AND status='running'`,
                        [action.id, action.status === 'sent' ? 'completed' : 'failed'],
                      );
                      await tx.client.query(
                        `UPDATE ${table(tx, 'tf_conversation_execution_steps')} SET output=jsonb_build_object('result',$2::jsonb,'sources',sources)
            WHERE call_id=$1 AND output IS NULL`,
                        [action.id, JSON.stringify({ provider: 'slack', id: action.id, status: action.status })],
                      );
                      const nextPlan = await planning?.finish?.(tx, { ...work, epoch: turn.attempt_epoch });
                      if (nextPlan?.kind === 'continue') {
                        await changed(tx, work, true);
                        return 'retry';
                      }
                      const id = randomUUID();
                      const text =
                        nextPlan?.text ??
                        (action.status === 'sent'
                          ? 'Slack confirmed the requested action.'
                          : `Slack action ${action.status}. No automatic resend will occur.`);
                      await tx.client.query(
                        `INSERT INTO ${table(tx, 'tf_conversation_messages')} (id,conversation_id,sequence,author_kind) VALUES ($1,$2,$3,'assistant')`,
                        [id, work.conversationId, chat.next_message_sequence],
                      );
                      await tx.client.query(
                        `INSERT INTO ${table(tx, 'tf_conversation_parts')} (conversation_id,message_id,ordinal,kind,text) VALUES ($1,$2,0,'text',$3)`,
                        [work.conversationId, id, text],
                      );
                      await tx.client.query(
                        `INSERT INTO ${table(tx, 'tf_conversation_results')} (conversation_id,turn_id,message_id,sources) VALUES ($1,$2,$3,$4)`,
                        [
                          work.conversationId,
                          work.turnId,
                          id,
                          JSON.stringify([{ kind: 'private-conversation', conversationId: work.conversationId }]),
                        ],
                      );
                      await tx.client.query(
                        `UPDATE ${table(tx, 'tf_conversation_turns')} SET status='completed',response_message_id=$2,error_code=NULL WHERE id=$1`,
                        [work.turnId, id],
                      );
                      await tx.client.query(
                        `UPDATE ${table(tx, 'tf_conversations')} SET next_message_sequence=next_message_sequence+1,activity_at=clock_timestamp() WHERE id=$1`,
                        [work.conversationId],
                      );
                      await recordConversationActivity(tx, work.conversationId);
                      await changed(tx, work, true);
                      const next = await head(tx, work.conversationId);
                      if (next)
                        await tx.client.query(
                          `INSERT INTO ${table(tx, 'tf_conversation_outbox')} (turn_id,conversation_id,generation) VALUES ($1,$2,$3) ON CONFLICT (turn_id,generation) DO UPDATE SET next_attempt_at=clock_timestamp(),dispatched_at=NULL`,
                          [next.id, work.conversationId, next.generation],
                        );
                      return 'completed';
                    }),
                };
              }
              return undefined;
            },
          );
          // Terminal Slack delivery already returned its transaction without entering the reply-recovery catch.
          if (resumed !== undefined)
            return typeof resumed === 'object' ? observeChatDetail('resume', resumed.finish) : resumed;
          fence = await staged('claim', () => claim(value));
          stage = 'prepare';
          return fence ? await complete(fence) : 'idle';
        } catch (error) {
          if (error instanceof ExternalActionWaiting) return 'idle';
          if (error instanceof CreditAttemptAlreadyDispatched) return 'stale';
          const code = telemetryErrorCode(
            typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
          );
          log('error', 'activity', 'call_failed', {
            operation: 'conversation.reply',
            'error.type': errorType(error),
            ...(code ? { 'error.code': code } : {}),
            'error.stage': (typeof error === 'object' && error !== null ? failedStages.get(error) : undefined) ?? stage,
            ...(error instanceof z.ZodError
              ? { 'error.issues': error.issues.map(issue => `${issue.path.join('.')}:${issue.code}`) }
              : {}),
          });
          const modelFailure = modelFailureSchema.safeParse(error instanceof Error ? error.message : null);
          const denied = error instanceof AccessDenied && !(error instanceof SourceAuthorizationUnavailable);
          if (fence) {
            try {
              return await fail(
                fence,
                error instanceof CreditsExhausted,
                modelFailure.success ? modelFailure.data : undefined,
                denied,
                planning?.failure?.(error)?.code,
              );
            } catch {
              throw new Error('conversation-reply-unavailable');
            }
          }
          throw new Error('conversation-reply-unavailable');
        }
      }),
    );
  }

  async function due(workspaceId: string): Promise<ReplyWork[]> {
    try {
      return await runtime.transaction(workspaceId, commonCompatibility, async tx => {
        const rows = z
          .array(
            z.object({ conversationId: uuidSchema, turnId: uuidSchema, generation: z.number().int().nonnegative() }),
          )
          .parse(
            (
              await tx.client.query(`SELECT t.conversation_id AS "conversationId", t.id AS "turnId", t.generation
          FROM ${table(tx, 'tf_conversation_turns')} t JOIN ${table(tx, 'tf_conversation_outbox')} o ON o.turn_id = t.id AND o.generation = t.generation
          WHERE ((t.status = 'queued' AND (t.retry_at IS NULL OR t.retry_at <= clock_timestamp())) OR (t.status = 'processing' AND t.lease_until <= clock_timestamp()) OR (t.status='waiting' AND t.error_code IN ('slack-action-waiting','mcp-action-waiting')))
          AND o.next_attempt_at <= clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_slack_default_turns')} s WHERE s.turn_id=t.id)
          AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_conversation_turns')} p WHERE p.conversation_id = t.conversation_id AND p.accepted_sequence < t.accepted_sequence AND p.status NOT IN ('completed', 'cancelled', 'blocked'))
          ORDER BY o.next_attempt_at, t.id LIMIT 50`)
            ).rows,
          );
        return rows.map(row => ({ workspaceId, ...row }));
      });
    } catch (error) {
      if (error instanceof StorageUnavailableError && error.code === 'incompatible_version') return [];
      throw error;
    }
  }

  async function acknowledge(value: unknown) {
    const work = replyWorkSchema.parse(value);
    return transaction(work.workspaceId, async tx => {
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_conversation_outbox')} SET dispatched_at = clock_timestamp(), next_attempt_at = clock_timestamp() + interval '30 seconds' WHERE turn_id = $1 AND conversation_id = $2 AND generation = $3`,
        [work.turnId, work.conversationId, work.generation],
      );
      if (tx.commonVersion >= 1)
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_turns')} SET timing_dispatched_at=clock_timestamp() WHERE id=$1 AND timing_started_at IS NOT NULL AND timing_dispatched_at IS NULL`,
          [work.turnId],
        );
    });
  }

  return { claim, complete, fail, process, due, acknowledge };
}
