import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  protectedSourceClosure,
  requireProtectedSource,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import {
  workflowTransaction,
  type WorkflowTransaction,
  workflowMember,
  hasGrant,
  readableWorkflow,
  requireGrant,
  requireSponsor,
  workflowSponsor,
  initializeManager,
  auditWorkflow,
  disableAutomatically,
  disabledReasonColumn,
} from './authorization.ts';
import { changeGrant, listGrants, sharingCandidates } from './sharing.ts';
import {
  afterCommit,
  qualified,
  type createWorkspaceRuntime,
  commonCompatibility,
  StorageUnavailableError,
} from '@tulipfarm/workspace-storage/runtime';
import { trackEvent } from '@tulipfarm/observability';
import {
  isSecretHeader,
  activationSchema,
  acceptSponsorshipSchema,
  commandSchema,
  isTableStep,
  webhookKeySchema,
  webhookToleranceSeconds,
  webhookDeliveryRetention,
  webhookDeliveryLogSchema,
  webhookOutcomeSchema,
  webhookTestSchema,
  definitionSchema,
  idSchema,
  maxWaitSeconds,
  payloadSchema,
  receiptSchema,
  withheldOutput,
  resolveValue,
  runCondition,
  ConditionIncomparable,
  nextStep,
  runHistoryCursorSchema,
  runHistoryPageSize,
  runHistoryQuerySchema,
  runSchema,
  saveSchema,
  sponsorshipSchema,
  startSchema,
  statusSchema,
  transform,
  triggerSchema,
  unfinishedStatuses,
  waitUntilInstant,
  workflowSchema,
  workSchema,
  type Progress,
  type Trigger,
  type Work,
} from './contracts.ts';
import {
  jobSchema,
  resultSchema,
  type SnippetClient,
  type SnippetJob,
  type SnippetResult,
} from '@tulipfarm/workflow-snippets/protocol';
import { calendarOccurrences, missedOccurrences, nextOccurrence } from './schedule.ts';
import { calendarRangeSchema, calendarFollowSchema, workflowCalendarSchema } from './calendar-contracts.ts';
import { createWorkflowProviders, type ProviderOptions } from './providers.ts';
import { administrativeCommand, WorkflowConflict, WorkflowLimitReached, workflowLimits } from './commands.ts';
import { canonical } from '@tulipfarm/workflow-snippets/canonical';
import { credentialCipher } from '@tulipfarm/integrations/credentials';
import {
  issueWebhookKey,
  matchWebhookKey,
  storedWebhookKeySchema,
  webhookProof,
  WebhookRejected,
  type StoredWebhookKey,
  type WebhookDelivery,
} from './webhook-keys.ts';
import {
  dueRecordOccurrences,
  markRecordOccurrenceFired,
  nextRecordSweep,
  reconcileRecordOccurrences,
  recordRunInput,
  recordSource,
  recordTriggerCommonVersion,
  requireRecordAudience,
  requireRecordReader,
  requireRecordZone,
  canReadRecords,
  settleMissedRecordOccurrences,
  upcomingRecordOccurrences,
  recordFilterLabels,
  type RecordTrigger,
} from './record-triggers.ts';
import {
  blockRowChange,
  dueRowChanges,
  rowRunInput,
  rowSource,
  rowTriggerCommonVersion,
  settleRowChange,
  type RowTrigger,
} from './row-triggers.ts';
import { bodyAt, deliveryRequestId, sentHeader, webhookSample, type WebhookHeaders } from './webhook-deliveries.ts';
import {
  requireTableStepAuthority,
  requireTableStepFields,
  requireTableStepReader,
  runTableStep,
} from './table-steps.ts';
import { requireAgentStepAuthority, requireAgentStepReader } from './agent-steps.ts';
import { HttpStepError, requestHttp } from './http.ts';
import { definitionQuerySchema, definitionViewSchema, runDetailSchema, workflowPersonSchema } from './contracts.ts';
export { ProviderFailure } from './provider-adapters.ts';
export { WebhookKeyUnavailable, WebhookRejected } from './webhook-keys.ts';

export type WorkflowRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
export { WorkflowConflict } from './commands.ts';
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const scheduledInstant = (input: unknown) => {
  const parsed = z.object({ scheduledFor: z.iso.datetime() }).safeParse(input);
  return parsed.success ? parsed.data.scheduledFor : null;
};
const utcInstant = (expression: string) => `to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
// Timers and Slack approval waits hold no worker while parked.
const parked = (tx: AuthorizationTransaction, run: string) =>
  `(CASE WHEN ${run}.status='waiting' AND ${run}.sponsorship_id IS NOT NULL THEN EXISTS (SELECT 1 FROM ${table(tx, 'tf_workflow_steps')} s JOIN ${table(tx, 'tf_workflow_revisions')} d ON d.workflow_id=${run}.workflow_id AND d.id=${run}.revision CROSS JOIN jsonb_array_elements(d.definition->'steps') e WHERE s.run_id=${run}.id AND s.status='waiting' AND s.due_at>clock_timestamp() AND e->>'id'=s.step_id AND e->>'kind' IN ('delay','wait-until','slack-message')) ELSE false END)`;
// Schedule decisions follow the database clock that due checks compare against, never the API host clock.
// Workspaces below common version 4 have no archived_at column, so none of their workflows is archived.
const unarchived = (tx: WorkflowTransaction, alias: string) =>
  tx.commonVersion >= 1 ? `${alias}.archived_at IS NULL` : 'true';
// Workspaces below common version 5 store only one bearer key digest: no signing key, grace period, or replay record.
const webhookRotation = (tx: WorkflowTransaction) => tx.commonVersion >= 1;
// Workspaces below common version 7 have no delivery log table.
const webhookLog = (tx: WorkflowTransaction) => tx.commonVersion >= 1;
const webhookCleared = (tx: WorkflowTransaction) =>
  webhookRotation(tx)
    ? 'webhook_digest=NULL,webhook_secret=NULL,webhook_previous=NULL,webhook_previous_expires_at=NULL'
    : 'webhook_digest=NULL';
const webhookColumns = (tx: WorkflowTransaction, alias: string) =>
  webhookRotation(tx)
    ? `CASE WHEN ${alias}.webhook_secret IS NOT NULL THEN COALESCE(${alias}.webhook_secret->>'mode','signed') WHEN ${alias}.webhook_digest IS NOT NULL THEN 'bearer' END AS "webhookMode",CASE WHEN ${alias}.webhook_previous_expires_at>clock_timestamp() THEN ${alias}.webhook_previous->>'mode' END AS "previousMode",CASE WHEN ${alias}.webhook_previous_expires_at>clock_timestamp() THEN ${utcInstant(`${alias}.webhook_previous_expires_at`)} END AS "previousExpiresAt"`
    : `CASE WHEN ${alias}.webhook_digest IS NOT NULL THEN 'bearer' END AS "webhookMode",NULL AS "previousMode",NULL AS "previousExpiresAt"`;
async function databaseNow(tx: AuthorizationTransaction) {
  return new Date(
    z.iso.datetime().parse((await tx.client.query(`SELECT ${utcInstant('clock_timestamp()')} AS now`)).rows[0].now),
  );
}

// A workflow that failed in a sweep sits out the next ones, so a lasting failure neither repeats every minute nor holds
// sweep places ahead of due work. Its next_run_at stays put, so the retry keeps the original due time and lateness window.
const failedSweepRetry = '5 minutes';

export const workflowCodeStepsEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.WORKFLOW_CODE_STEPS_ENABLED === 'true';

/** Whether `actor` may read every source a workflow agent task's result retained. Without it, history withholds agent results. */
type AgentResultReadable = (tx: AuthorizationTransaction, actor: HumanActor, taskId: string) => Promise<boolean>;

type AgentTaskClient = {
  start(
    workspaceId: string,
    user: string,
    value: {
      requestId: string;
      agentId: string;
      text: string;
      limits: { toolCalls: number; activeMilliseconds: number; credits: number };
    },
  ): Promise<{ id: string }>;
  result(
    workspaceId: string,
    user: string,
    id: string,
  ): Promise<{
    status: 'pending' | 'completed' | 'waiting-clarification' | 'waiting-approval' | 'paused' | 'failed';
    text?: string;
    pauseReason?: string | null;
  }>;
};
type SlackClient = {
  workflow(
    workspaceId: string,
    runId: string,
    stepId: string,
    actionId: string,
  ): Promise<{
    id: string;
    status: string;
    expiresAt: string;
    nextAttemptAt: string;
    sentMessageTs?: string | null | undefined;
  }>;
};

export function createWorkflows(
  runtime: WorkflowRuntime,
  options: ProviderOptions & {
    snippets?: SnippetClient;
    codeSteps?: boolean;
    agentTasks?: AgentTaskClient;
    agentSteps?: boolean;
    agentResultReadable?: AgentResultReadable;
    slackActions?: SlackClient;
    wake?: (work: Work) => Promise<void>;
    webhookToleranceSeconds?: number;
  } = {},
) {
  const providers = createWorkflowProviders(runtime, options);
  const cipher = credentialCipher(options.keyring);
  const tolerance = options.webhookToleranceSeconds ?? webhookToleranceSeconds;
  // The API composes no runner client, so it learns from configuration whether the worker can execute code steps.
  const codeStepsAvailable = options.codeSteps ?? options.snippets !== undefined;
  const agentStepsAvailable = options.agentSteps ?? options.agentTasks !== undefined;
  function requireCodeRunner(definition: z.infer<typeof definitionSchema>) {
    if (!codeStepsAvailable && definition.steps.some(step => step.kind === 'code'))
      throw new WorkflowConflict('code-steps-unavailable');
  }
  function requireAgentRunner(definition: z.infer<typeof definitionSchema>) {
    if (!agentStepsAvailable && definition.steps.some(step => step.kind === 'agent'))
      throw new WorkflowConflict('agent-steps-unavailable');
  }
  function transaction<T>(
    workspaceId: string,
    operation: (tx: WorkflowTransaction) => Promise<T>,
    mode: 'read' | 'write' = 'write',
  ) {
    return workflowTransaction(runtime, workspaceId, operation, mode);
  }
  // A trigger that reads a source carries that source's data into runs, so each member who sponsors or sees them needs source access.
  async function authorizeSource(tx: AuthorizationTransaction, trigger: Trigger, membershipId: string) {
    if (trigger.kind === 'provider') await providers.authorize(tx, trigger, membershipId);
    if (trigger.kind === 'record' || trigger.kind === 'row') await requireRecordReader(tx, membershipId, trigger);
  }
  async function authorizeSources(
    tx: AuthorizationTransaction,
    definition: z.infer<typeof definitionSchema>,
    membershipId: string,
  ) {
    await authorizeSource(tx, definition.trigger, membershipId);
    await requireTableStepReader(tx, membershipId, definition);
    await requireAgentStepReader(tx, membershipId, definition);
    for (const step of definition.steps)
      if (step.kind === 'http' && step.credential)
        await providers.authorizeIntegration(tx, step.credential.integrationId, membershipId);
  }
  async function slackOrigin(tx: WorkflowTransaction, runId: string, stepId: string) {
    if (tx.commonVersion < 1) throw new AccessDenied();
    const run = (
      await tx.client.query(
        `SELECT r.*,m.user_id,d.definition,w.enabled,w.sponsor_membership_id,w.sponsorship_id AS current_sponsorship_id FROM ${table(tx, 'tf_workflow_runs')} r JOIN ${table(tx, 'tf_memberships')} m ON m.id=r.membership_id AND m.removed_at IS NULL JOIN ${table(tx, 'tf_workflow_revisions')} d ON d.workflow_id=r.workflow_id AND d.id=r.revision JOIN ${table(tx, 'tf_workflows')} w ON w.id=r.workflow_id WHERE r.id=$1`,
        [idSchema.parse(runId)],
      )
    ).rows[0];
    if (
      !run ||
      !run.enabled ||
      !['running', 'waiting'].includes(run.status) ||
      !(await hasGrant(tx, run.membership_id, run.workflow_id, 'invoke')) ||
      (run.sponsorship_id
        ? run.sponsorship_id !== run.current_sponsorship_id || run.membership_id !== run.sponsor_membership_id
        : !/^(manual|event):/.test(run.request_key))
    )
      throw new AccessDenied();
    const definition = definitionSchema.parse(run.definition);
    await authorizeSources(tx, definition, run.membership_id);
    const rows = (
      await tx.client.query(`SELECT step_id,status,output FROM ${table(tx, 'tf_workflow_steps')} WHERE run_id=$1`, [
        runId,
      ])
    ).rows;
    const outputs = new Map<string, z.infer<typeof payloadSchema>>();
    for (const row of rows) if (row.status === 'completed') outputs.set(row.step_id, payloadSchema.parse(row.output));
    const next = nextStep(definition.steps, outputs);
    if (
      next?.step.id !== stepId ||
      next.step.kind !== 'slack-message' ||
      !rows.some(row => row.step_id === stepId && row.status === 'waiting')
    )
      throw new AccessDenied();
    const checkSource = (value: typeof next.step.text): void => {
      if (value.kind !== 'step') return;
      const source = definition.steps.find(step => step.id === value.step);
      if (!source || source.kind === 'agent' || source.kind === 'http') throw new AccessDenied();
      if (source.kind === 'transform') for (const dependency of Object.values(source.fields)) checkSource(dependency);
      if (source.kind === 'code') checkSource(source.input);
    };
    checkSource(next.step.text);
    const text = z
      .string()
      .min(1)
      .max(4000)
      .parse(resolveValue(next.step.text, payloadSchema.parse(run.input), outputs));
    return {
      actor: {
        kind: 'human' as const,
        userId: z.string().parse(run.user_id),
        membershipId: idSchema.parse(run.membership_id),
      },
      workflowId: idSchema.parse(run.workflow_id),
      revision: idSchema.parse(run.revision),
      action: { tool: 'slack.message.send' as const, destinationId: next.step.destinationId, text },
    };
  }
  // Steps saved before the sender choice existed keep posting through the requester's account.
  async function slackSender(tx: WorkflowTransaction, runId: string, stepId: string) {
    const run = (
      await tx.client.query(
        `SELECT d.definition FROM ${table(tx, 'tf_workflow_runs')} r JOIN ${table(tx, 'tf_workflow_revisions')} d ON d.workflow_id=r.workflow_id AND d.id=r.revision WHERE r.id=$1`,
        [idSchema.parse(runId)],
      )
    ).rows[0];
    if (!run) throw new AccessDenied();
    const step = definitionSchema.parse(run.definition).steps.find(step => step.id === stepId);
    if (step?.kind !== 'slack-message') throw new AccessDenied();
    return step.sender ?? 'user';
  }
  async function slackSources(tx: WorkflowTransaction, runId: string, stepId: string, membershipId: string) {
    if (tx.commonVersion < 1) throw new AccessDenied();
    const run = (
      await tx.client.query(
        `SELECT r.workflow_id,r.membership_id,d.definition FROM ${table(tx, 'tf_workflow_runs')} r JOIN ${table(tx, 'tf_workflow_revisions')} d ON d.workflow_id=r.workflow_id AND d.id=r.revision WHERE r.id=$1`,
        [idSchema.parse(runId)],
      )
    ).rows[0];
    if (!run || run.membership_id !== membershipId || !(await hasGrant(tx, membershipId, run.workflow_id, 'read')))
      throw new AccessDenied();
    const definition = definitionSchema.parse(run.definition);
    await authorizeSources(tx, definition, membershipId);
    const step = definition.steps.find(step => step.id === stepId);
    if (step?.kind !== 'slack-message') throw new AccessDenied();
    const authored = (value: typeof step.text): boolean => {
      if (value.kind === 'literal') return true;
      if (value.kind === 'input') return false;
      const source = definition.steps.find(step => step.id === value.step);
      if (!source) throw new AccessDenied();
      if (source.kind === 'transform') return Object.values(source.fields).some(authored);
      return source.kind === 'code' || source.kind === 'agent' || source.kind === 'http';
    };
    return { authoredText: authored(step.text) };
  }
  // Waiting runs sleep on one durable timer; a committed change that ends or resumes the wait wakes them.
  async function wakeAfter<T>(
    workspaceId: string,
    operation: (tx: WorkflowTransaction, woken: Set<string>) => Promise<T>,
  ) {
    const woken = new Set<string>();
    const result = await transaction(workspaceId, tx => operation(tx, woken));
    const wake = options.wake;
    if (wake) await Promise.all([...woken].map(runId => wake({ workspaceId, runId })));
    return result;
  }
  async function liveRuns(tx: AuthorizationTransaction, workflowId: string, woken: Set<string>) {
    for (const row of (
      await tx.client.query(
        `SELECT id FROM ${table(tx, 'tf_workflow_runs')} WHERE workflow_id=$1 AND status IN ('queued','running','waiting')`,
        [idSchema.parse(workflowId)],
      )
    ).rows)
      woken.add(idSchema.parse(row.id));
  }
  async function read(tx: WorkflowTransaction, id: string, membershipId?: string) {
    const row = (
      await tx.client.query(
        `SELECT w.id,w.revision,w.active_revision AS "activeRevision",w.enabled,w.generation,${utcInstant('w.next_run_at')} AS "nextRunAt",w.sponsor_membership_id AS "sponsorMembershipId",(w.sponsorship_id IS NOT NULL AND w.sponsorship_revision=w.revision) AS "sponsorshipAccepted",r.definition,a.definition->'trigger' AS "activeTrigger",${disabledReasonColumn(tx, 'w')},${webhookColumns(tx, 'w')},${tx.commonVersion >= 1 ? utcInstant('w.archived_at') : 'NULL'} AS "archivedAt" FROM ${table(tx, 'tf_workflows')} w JOIN ${table(tx, 'tf_workflow_revisions')} r ON r.workflow_id=w.id AND r.id=w.revision LEFT JOIN ${table(tx, 'tf_workflow_revisions')} a ON a.workflow_id=w.id AND a.id=w.active_revision WHERE w.id=$1`,
        [idSchema.parse(id)],
      )
    ).rows[0];
    if (!row) throw new AccessDenied();
    const sponsor = row.sponsorMembershipId
      ? (
          await tx.client.query(
            `SELECT id,user_id AS "userId",user_id AS name FROM ${table(tx, 'tf_memberships')} WHERE id=$1`,
            [row.sponsorMembershipId],
          )
        ).rows[0]
      : null;
    const capabilities = {
      read: !!membershipId && (await hasGrant(tx, membershipId, id, 'read')),
      invoke: !!membershipId && (await hasGrant(tx, membershipId, id, 'invoke')),
      manage: !!membershipId && (await hasGrant(tx, membershipId, id, 'manage')),
    };
    const historyAudience =
      capabilities.manage || row.sponsorMembershipId === membershipId
        ? (
            await tx.client.query(
              `SELECT membership_id FROM ${table(tx, 'tf_workflow_history_audience')} WHERE workflow_id=$1 ORDER BY membership_id`,
              [id],
            )
          ).rows.map(item => idSchema.parse(item.membership_id))
        : [];
    const { previousMode, previousExpiresAt, ...workflow } = row;
    const activeTrigger = row.activeTrigger === null ? null : triggerSchema.parse(row.activeTrigger);
    const rowQueue = membershipId && capabilities.read ? await readRowQueue(tx, id, membershipId, activeTrigger) : null;
    const result = {
      ...workflow,
      rowQueue,
      webhookConfigured: row.webhookMode !== null,
      webhookRotation: webhookRotation(tx),
      webhookPrevious: previousMode ? { mode: previousMode, expiresAt: previousExpiresAt } : null,
      sponsor,
      capabilities,
      historyAudience,
    };
    // A row workflow's next_run_at is only its next read of the table, not a run anyone scheduled.
    if (activeTrigger?.kind === 'row') return workflowSchema.parse({ ...result, nextRunAt: null });
    if (activeTrigger?.kind !== 'record') return workflowSchema.parse(result);
    // The sweep timer also rereads the table every minute, so a record workflow's next run is its earliest occurrence.
    // Null tells a viewer who cannot read the table that dates are hidden, not that none are due.
    const upcomingRecords =
      membershipId && capabilities.read && (await canReadRecords(tx, membershipId, activeTrigger.tableId))
        ? row.enabled
          ? await upcomingRecordOccurrences(tx, id, row.activeRevision, 10)
          : []
        : null;
    return workflowSchema.parse({ ...result, nextRunAt: upcomingRecords?.[0]?.dueAt ?? null, upcomingRecords });
  }
  async function readRowQueue(
    tx: WorkflowTransaction,
    id: string,
    membershipId: string,
    activeTrigger: Trigger | null,
  ) {
    if (activeTrigger?.kind === 'row' && !(await canReadRecords(tx, membershipId, activeTrigger.tableId))) return null;
    if (tx.commonVersion < rowTriggerCommonVersion)
      return activeTrigger?.kind === 'row'
        ? { available: false, pending: 0, blocked: 0, cancelled: 0, oldestAt: null, blockers: [] }
        : null;
    const sources = (
      await tx.client.query(
        `SELECT DISTINCT table_id FROM ${table(tx, 'tf_workflow_row_events')} WHERE workflow_id=$1`,
        [id],
      )
    ).rows;
    if (!sources.length && activeTrigger?.kind !== 'row') return null;
    for (const source of sources) if (!(await canReadRecords(tx, membershipId, source.table_id))) return null;
    const counts = (
      await tx.client.query(
        `SELECT count(*) FILTER (WHERE state='pending')::integer AS pending,count(*) FILTER (WHERE state='blocked')::integer AS blocked,count(*) FILTER (WHERE state='cancelled')::integer AS cancelled,${utcInstant('min(changed_at) FILTER (WHERE settled_at IS NULL)')} AS "oldestAt" FROM ${table(tx, 'tf_workflow_row_events')} WHERE workflow_id=$1`,
        [id],
      )
    ).rows[0];
    const blockers = (
      await tx.client.query(
        `SELECT reason,count(*)::integer AS count FROM ${table(tx, 'tf_workflow_row_events')} WHERE workflow_id=$1 AND state='blocked' GROUP BY reason ORDER BY reason`,
        [id],
      )
    ).rows;
    return { available: true, ...counts, blockers };
  }
  async function requireUnarchived(tx: WorkflowTransaction, id: string) {
    if (
      (
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_workflows')} w WHERE w.id=$1 AND NOT (${unarchived(tx, 'w')})`,
          [idSchema.parse(id)],
        )
      ).rowCount
    )
      throw new WorkflowConflict('workflow-archived');
  }
  async function savableRecordSource(tx: WorkflowTransaction, trigger: RecordTrigger, membershipId: string) {
    if (tx.commonVersion < recordTriggerCommonVersion) throw new WorkflowConflict('record-trigger-unavailable');
    const generation = await recordSource(tx, trigger, membershipId);
    await requireRecordZone(tx, trigger);
    return generation;
  }
  async function savableRowSource(tx: WorkflowTransaction, trigger: RowTrigger, membershipId: string) {
    if (tx.commonVersion < rowTriggerCommonVersion) throw new WorkflowConflict('record-trigger-unavailable');
    return rowSource(tx, trigger, membershipId);
  }
  /** Runs the record checks a save would, so a chat draft fails before review, and names the table and field for the card. */
  async function recordSourceLabels(workspaceId: string, user: string, trigger: RecordTrigger) {
    return transaction(workspaceId, async tx => {
      const { definition } = await savableRecordSource(tx, trigger, (await workflowMember(tx, user)).membershipId);
      const field = definition.fields.find(item => item.id === trigger.field.fieldId);
      if (!field) throw new WorkflowConflict('record-field-unavailable');
      return {
        table: definition.label,
        field: field.label,
        filter: trigger.filter ? recordFilterLabels(definition.fields, trigger.filter) : null,
      };
    });
  }
  /** Runs the row checks a save would, so a chat draft fails before review, and names the table, watched fields, and filter for the card. */
  async function rowSourceLabels(workspaceId: string, user: string, trigger: RowTrigger) {
    return transaction(workspaceId, async tx => {
      const { definition } = await savableRowSource(tx, trigger, (await workflowMember(tx, user)).membershipId);
      const label = (id: string) => definition.fields.find(item => item.id === id)?.label ?? '';
      return {
        table: definition.label,
        fields: trigger.fieldIds?.map(label) ?? [],
        filter: trigger.filter ? recordFilterLabels(definition.fields, trigger.filter) : null,
      };
    });
  }
  /** Runs the table step checks a save, and the activation that makes the member sponsor, would, so a chat draft fails before review. */
  async function checkTableSteps(workspaceId: string, user: string, definition: z.infer<typeof definitionSchema>) {
    return transaction(workspaceId, async tx => {
      const { membershipId } = await workflowMember(tx, user);
      const labels = await requireTableStepFields(tx, membershipId, definition);
      if (!['manual', 'event'].includes(definition.trigger.kind))
        await requireTableStepAuthority(tx, definition, membershipId, []);
      return labels;
    });
  }
  async function list(workspaceId: string, user: string, options: { archived?: boolean } = {}) {
    return transaction(
      workspaceId,
      async tx => {
        const actor = await workflowMember(tx, user);
        if (options.archived) {
          if (tx.commonVersion < 1) return [];
          // Archived workflows have no quota, so filter by access before the limit or older readable ones would be cut off.
          const archived = (
            await tx.client.query(
              `SELECT w.id FROM ${table(tx, 'tf_workflows')} w WHERE w.archived_at IS NOT NULL AND ${readableWorkflow(tx, 'w', '$1')} ORDER BY w.archived_at DESC,w.id LIMIT 100`,
              [actor.membershipId],
            )
          ).rows;
          const result = [];
          for (const row of archived) result.push(await read(tx, row.id, actor.membershipId));
          return result;
        }
        const rows = (
          await tx.client.query(
            `SELECT w.id FROM ${table(tx, 'tf_workflows')} w WHERE ${unarchived(tx, 'w')} ORDER BY w.id LIMIT 100`,
          )
        ).rows;
        const result = [];
        for (const row of rows)
          if (await hasGrant(tx, actor.membershipId, row.id, 'read'))
            result.push(await read(tx, row.id, actor.membershipId));
        return result;
      },
      'read',
    );
  }
  async function calendar(workspaceId: string, user: string, value: unknown) {
    const range = calendarRangeSchema.parse(value);
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      if (tx.commonVersion < 1) throw new StorageUnavailableError('incompatible_version');
      const rows = (
        await tx.client.query(
          `SELECT w.id,
        (w.sponsor_membership_id=$1 OR (SELECT author_membership_id FROM ${table(tx, 'tf_workflow_revisions')} WHERE workflow_id=w.id ORDER BY created_at,id LIMIT 1)=$1) AS personal,
        EXISTS (SELECT 1 FROM ${table(tx, 'tf_calendar_workflow_follows')} f WHERE f.workflow_id=w.id AND f.membership_id=$1) AS following
        FROM ${table(tx, 'tf_workflows')} w WHERE ${unarchived(tx, 'w')} AND ${readableWorkflow(tx, 'w', '$1')} ORDER BY w.id LIMIT 101`,
          [actor.membershipId],
        )
      ).rows;
      const workflows: z.infer<typeof workflowCalendarSchema>['workflows'] = [];
      const actions: z.infer<typeof workflowCalendarSchema>['actions'] = [];
      let more = rows.length > 100;
      for (const row of rows.slice(0, 100)) {
        const current = await read(tx, row.id, actor.membershipId);
        const personal = row.personal === true,
          following = row.following === true;
        const projected =
          current.enabled && current.activeTrigger && current.nextRunAt && (personal || following)
            ? current.activeTrigger.kind === 'record'
              ? {
                  times: (current.upcomingRecords ?? [])
                    .map(item => item.dueAt)
                    .filter(at => Date.parse(at) >= Date.parse(range.from) && Date.parse(at) < Date.parse(range.to)),
                  more: (current.upcomingRecords?.length ?? 0) === 10,
                }
              : calendarOccurrences(current.activeTrigger, current.nextRunAt, range.from, range.to)
            : { times: [], more: false };
        const occurrences: z.infer<typeof workflowCalendarSchema>['workflows'][number]['occurrences'] =
          projected.times.map(at => ({ at, status: 'Scheduled' }));
        more ||= projected.more;
        const runs = (
          await tx.client.query(
            `SELECT r.id,r.status,${utcInstant('COALESCE(r.scheduled_for,r.started_at,r.created_at)')} AS at
          FROM ${table(tx, 'tf_workflow_runs')} r WHERE r.workflow_id=$1 AND
          ((r.membership_id=$2 AND r.sponsorship_id IS NULL) OR EXISTS (SELECT 1 FROM ${table(tx, 'tf_workflow_run_audience')} a WHERE a.run_id=r.id AND a.membership_id=$2))
          AND (r.status='waiting' OR (COALESCE(r.scheduled_for,r.started_at,r.created_at)>=$3 AND COALESCE(r.scheduled_for,r.started_at,r.created_at)<$4))
          ORDER BY r.created_at DESC,r.id DESC LIMIT 251`,
            [current.id, actor.membershipId, range.from, range.to],
          )
        ).rows;
        more ||= runs.length > 250;
        for (const run of runs.slice(0, 250)) {
          try {
            await requireRunAccess(tx, actor.membershipId, current.id, run.id, false);
          } catch (error) {
            if (error instanceof AccessDenied) continue;
            throw error;
          }
          if (
            (personal || following) &&
            Date.parse(run.at) >= Date.parse(range.from) &&
            Date.parse(run.at) < Date.parse(range.to)
          ) {
            const existing = occurrences.findIndex(item => item.at === run.at);
            if (existing >= 0) occurrences.splice(existing, 1);
            occurrences.push({ at: run.at, runId: run.id, status: run.status });
          }
          if (run.status === 'waiting' && current.capabilities.invoke) {
            const steps = (
              await tx.client.query(
                `SELECT step_id,prompt FROM ${table(tx, 'tf_workflow_steps')} WHERE run_id=$1 AND status='waiting' AND prompt IS NOT NULL ORDER BY ordinal`,
                [run.id],
              )
            ).rows;
            for (const step of steps)
              actions.push({
                workflowId: current.id,
                runId: run.id,
                stepId: step.step_id,
                title: `${current.definition.name}: ${step.step_id}`,
              });
          }
        }
        workflows.push({
          id: current.id,
          name: current.definition.name,
          personal,
          following,
          enabled: current.enabled,
          occurrences,
          more: projected.more,
        });
      }
      return workflowCalendarSchema.parse({ workflows, actions, more });
    });
  }
  async function followCalendar(workspaceId: string, user: string, id: string, value: unknown) {
    const input = calendarFollowSchema.parse(value);
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      if (tx.commonVersion < 1) throw new StorageUnavailableError('incompatible_version');
      await requireGrant(tx, actor.membershipId, id, 'read');
      if (input.following)
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_calendar_workflow_follows')} (membership_id,workflow_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [actor.membershipId, id],
        );
      else
        await tx.client.query(
          `DELETE FROM ${table(tx, 'tf_calendar_workflow_follows')} WHERE membership_id=$1 AND workflow_id=$2`,
          [actor.membershipId, id],
        );
      return input;
    });
  }
  async function recent(workspaceId: string, user: string) {
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      return z.array(z.object({ id: idSchema, name: z.string() })).parse(
        (
          await tx.client.query(
            `SELECT w.id,r.definition->>'name' AS name FROM ${table(tx, 'tf_workflows')} w
         JOIN ${table(tx, 'tf_workflow_revisions')} r ON r.workflow_id=w.id AND r.id=w.revision
         WHERE ${unarchived(tx, 'w')} AND ${readableWorkflow(tx, 'w', '$1')}
         ORDER BY r.created_at DESC,w.id DESC LIMIT 3`,
            [actor.membershipId],
          )
        ).rows,
      );
    });
  }
  async function save(workspaceId: string, user: string, id: string, value: unknown) {
    id = idSchema.parse(id);
    const input = saveSchema.parse(value);
    try {
      nextOccurrence(input.definition.trigger, new Date());
    } catch {
      throw new WorkflowConflict('invalid-schedule');
    }
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      const previous = (await tx.client.query(`SELECT revision FROM ${table(tx, 'tf_workflows')} WHERE id=$1`, [id]))
        .rows[0];
      if (input.definition.steps.some(step => step.kind === 'slack-message') && tx.commonVersion < 1)
        throw new WorkflowConflict('slack-action-unavailable');
      if (
        input.definition.steps.some(step => step.kind === 'slack-message' && step.sender === 'app') &&
        tx.commonVersion < 1
      )
        throw new WorkflowConflict('slack-action-unavailable');
      if (previous) await requireGrant(tx, actor.membershipId, id, 'manage');
      const existing = (
        await tx.client.query(
          `SELECT definition FROM ${table(tx, 'tf_workflow_revisions')} WHERE workflow_id=$1 AND id=$2`,
          [id, input.revision],
        )
      ).rows[0];
      if (existing) {
        if (canonical(definitionSchema.parse(existing.definition)) !== canonical(input.definition))
          throw new WorkflowConflict('revision-conflict');
        return read(tx, id, actor.membershipId);
      }
      if (previous) await requireUnarchived(tx, id);
      requireCodeRunner(input.definition);
      requireAgentRunner(input.definition);
      const trigger = input.definition.trigger;
      if (trigger.kind === 'provider') await providers.authorize(tx, trigger, actor.membershipId);
      if (trigger.kind === 'once' && Date.parse(trigger.at) <= (await databaseNow(tx)).getTime())
        throw new WorkflowConflict('schedule-in-past');
      if (trigger.kind === 'record') await savableRecordSource(tx, trigger, actor.membershipId);
      if (trigger.kind === 'row') await savableRowSource(tx, trigger, actor.membershipId);
      await requireTableStepFields(tx, actor.membershipId, input.definition);
      await requireAgentStepReader(tx, actor.membershipId, input.definition);
      if ((previous?.revision ?? null) !== input.expectedRevision) throw new WorkflowConflict('stale-revision');
      if (!previous) {
        const counts = z.object({ workspace: z.number(), member: z.number() }).parse(
          (
            await tx.client.query(
              `SELECT count(*)::integer AS workspace,
          count(*) FILTER (WHERE (SELECT r.author_membership_id FROM ${table(tx, 'tf_workflow_revisions')} r WHERE r.workflow_id=w.id ORDER BY r.created_at,r.id LIMIT 1)=$1)::integer AS member
          FROM ${table(tx, 'tf_workflows')} w WHERE ${unarchived(tx, 'w')}`,
              [actor.membershipId],
            )
          ).rows[0],
        );
        if (counts.member >= workflowLimits.member) throw new WorkflowLimitReached('member');
        if (counts.workspace >= workflowLimits.workspace) throw new WorkflowLimitReached('workspace');
        await tx.client.query(`INSERT INTO ${table(tx, 'tf_workflows')} (id,revision) VALUES ($1,$2)`, [
          id,
          input.revision,
        ]);
        await initializeManager(tx, id, actor.membershipId);
      }
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_workflow_revisions')} (workflow_id,id,definition,author_membership_id) VALUES ($1,$2,$3,$4)`,
        [id, input.revision, JSON.stringify(input.definition), actor.membershipId],
      );
      if (previous)
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_workflows')} SET revision=$2,generation=generation+1 WHERE id=$1`,
          [id, input.revision],
        );
      await auditWorkflow(tx, actor.membershipId, 'workflow.save', id);
      afterCommit(tx.client, () =>
        trackEvent('workflow_saved', { userId: user, workspaceId }, { workflow_id: id, created: !previous }),
      );
      return read(tx, id, actor.membershipId);
    });
  }
  async function activate(workspaceId: string, user: string, id: string, value: unknown) {
    const input = activationSchema.parse(value);
    const { revision, enabled } = input;
    return wakeAfter(workspaceId, async (tx, woken) => {
      const actor = await workflowMember(tx, user);
      await requireGrant(tx, actor.membershipId, id, 'manage');
      const current = await read(tx, id);
      await administrativeCommand(
        tx,
        {
          ...input,
          generation: current.generation,
          membershipId: actor.membershipId,
          operation: 'activate',
          target: current.id,
          request: input,
        },
        async () => {
          await requireUnarchived(tx, id);
          if (current.revision !== revision) throw new WorkflowConflict('stale-revision');
          if (current.activeRevision === revision && current.enabled === enabled) return;
          if (enabled) {
            requireCodeRunner(current.definition);
            requireAgentRunner(current.definition);
          }
          const trigger = current.definition.trigger;
          if (enabled && !['manual', 'event'].includes(trigger.kind)) {
            const sponsor = await requireSponsor(tx, id, revision);
            await requireTableStepAuthority(
              tx,
              current.definition,
              sponsor.sponsor_membership_id,
              (
                await tx.client.query(
                  `SELECT membership_id FROM ${table(tx, 'tf_workflow_history_audience')} WHERE workflow_id=$1`,
                  [id],
                )
              ).rows.map(row => idSchema.parse(row.membership_id)),
            );
            await requireAgentStepAuthority(
              tx,
              current.definition,
              sponsor.sponsor_membership_id,
              (
                await tx.client.query(
                  `SELECT membership_id FROM ${table(tx, 'tf_workflow_history_audience')} WHERE workflow_id=$1`,
                  [id],
                )
              ).rows.map(row => idSchema.parse(row.membership_id)),
            );
          }
          if (enabled && trigger.kind === 'provider') await providers.activate(tx, id, revision, trigger);
          if (enabled && (trigger.kind === 'record' || trigger.kind === 'row')) {
            const sponsor = (await requireSponsor(tx, id, revision)).sponsor_membership_id;
            await requireRecordAudience(tx, trigger, [sponsor]);
            if (trigger.kind === 'record') await recordSource(tx, trigger, sponsor);
            else await savableRowSource(tx, trigger, sponsor);
          }
          // Occurrences not yet fired belong to the previous activation; the next sweep recomputes them from this one.
          if (tx.commonVersion >= recordTriggerCommonVersion) {
            await tx.client.query(
              `DELETE FROM ${table(tx, 'tf_workflow_record_occurrences')} WHERE workflow_id=$1 AND fired_at IS NULL`,
              [id],
            );
            if (enabled)
              await tx.client.query(
                `UPDATE ${table(tx, 'tf_workflows')} SET activated_at=clock_timestamp() WHERE id=$1`,
                [id],
              );
          }
          if (!enabled)
            await tx.client.query(`UPDATE ${table(tx, 'tf_provider_polls')} SET fence=$2 WHERE workflow_id=$1`, [
              id,
              randomUUID(),
            ]);
          const fired =
            trigger.kind === 'once' &&
            (
              await tx.client.query(
                `SELECT 1 FROM ${table(tx, 'tf_workflow_runs')} WHERE workflow_id=$1 AND revision=$2 AND request_key LIKE 'schedule:%' LIMIT 1`,
                [id, revision],
              )
            ).rowCount === 1;
          const next = fired ? null : nextOccurrence(trigger, await databaseNow(tx));
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_workflows')} SET active_revision=$2,enabled=$3,next_run_at=$4,generation=generation+1 WHERE id=$1`,
            [id, revision, enabled, next],
          );
          if (trigger.kind !== 'webhook')
            await tx.client.query(`UPDATE ${table(tx, 'tf_workflows')} SET ${webhookCleared(tx)} WHERE id=$1`, [id]);
          if (!enabled)
            for (const row of (
              await tx.client.query(
                `UPDATE ${table(tx, 'tf_workflow_runs')} SET status='blocked',error='workflow-disabled' WHERE workflow_id=$1 AND status IN ('queued','running','waiting') RETURNING id`,
                [id],
              )
            ).rows)
              woken.add(idSchema.parse(row.id));
          await auditWorkflow(
            tx,
            actor.membershipId,
            enabled ? 'workflow.activate' : 'workflow.disable',
            id,
            current.activeRevision !== null,
          );
        },
      );
      return read(tx, id, actor.membershipId);
    });
  }
  async function archive(workspaceId: string, user: string, id: string, value: unknown) {
    const input = commandSchema.parse(value);
    return wakeAfter(workspaceId, async (tx, woken) => {
      const actor = await workflowMember(tx, user);
      await requireGrant(tx, actor.membershipId, id, 'manage');
      if (tx.commonVersion < 1) throw new WorkflowConflict('workflow-archive-unavailable');
      const current = await read(tx, id);
      await administrativeCommand(
        tx,
        {
          ...input,
          generation: current.generation,
          membershipId: actor.membershipId,
          operation: 'archive',
          target: current.id,
          request: input,
        },
        async () => {
          await requireUnarchived(tx, id);
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_workflows')} SET archived_at=clock_timestamp(),enabled=false,next_run_at=NULL,${webhookCleared(tx)},generation=generation+1 WHERE id=$1`,
            [id],
          );
          await tx.client.query(`UPDATE ${table(tx, 'tf_provider_polls')} SET fence=$2 WHERE workflow_id=$1`, [
            id,
            randomUUID(),
          ]);
          await tx.client.query(
            `DELETE FROM ${table(tx, 'tf_provider_events')} WHERE workflow_id=$1 AND NOT admitted`,
            [id],
          );
          for (const row of (
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_workflow_runs')} SET status='blocked',error='workflow-archived' WHERE workflow_id=$1 AND status IN ('queued','running','waiting') RETURNING id`,
              [id],
            )
          ).rows)
            woken.add(idSchema.parse(row.id));
          await auditWorkflow(tx, actor.membershipId, 'workflow.archive', id);
        },
      );
      return { archived: true };
    });
  }
  async function cancelRowEvents(workspaceId: string, user: string, id: string, value: unknown) {
    const input = commandSchema.parse(value);
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      await requireGrant(tx, actor.membershipId, id, 'manage');
      if (tx.commonVersion < rowTriggerCommonVersion) throw new WorkflowConflict('record-trigger-unavailable');
      const current = await read(tx, id);
      if (!(await readRowQueue(tx, id, actor.membershipId, current.activeTrigger))) throw new AccessDenied();
      await administrativeCommand(
        tx,
        {
          ...input,
          generation: current.generation,
          membershipId: actor.membershipId,
          operation: 'row-events-cancel',
          target: current.id,
          request: input,
        },
        async () => {
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_workflow_row_events')} SET state='cancelled',reason='user-cancelled',settled_at=clock_timestamp(),snapshot=NULL WHERE workflow_id=$1 AND settled_at IS NULL`,
            [id],
          );
          await tx.client.query(`UPDATE ${table(tx, 'tf_workflows')} SET generation=generation+1 WHERE id=$1`, [id]);
          await auditWorkflow(tx, actor.membershipId, 'workflow.row-events.cancel', id);
        },
      );
      return read(tx, id, actor.membershipId);
    });
  }
  async function admit(
    tx: WorkflowTransaction,
    workflowId: string,
    key: string,
    input: z.infer<typeof payloadSchema>,
    membershipId: string | null,
    replayed: (input: z.infer<typeof payloadSchema>, trigger: Trigger | null) => unknown = value => value,
  ) {
    const current = await read(tx, workflowId);
    const sponsor = membershipId === null ? await workflowSponsor(tx, workflowId) : null;
    membershipId = membershipId ?? sponsor?.sponsor_membership_id ?? null;
    if (!membershipId) throw new AccessDenied();
    if (!sponsor) await requireGrant(tx, membershipId, workflowId, 'invoke');
    const active = (
      await tx.client.query(
        `SELECT definition FROM ${table(tx, 'tf_workflow_revisions')} WHERE workflow_id=$1 AND id=$2`,
        [workflowId, current.activeRevision],
      )
    ).rows[0];
    const activeDefinition = active ? definitionSchema.parse(active.definition) : null,
      trigger = activeDefinition?.trigger ?? null;
    if (activeDefinition) await authorizeSources(tx, activeDefinition, membershipId);
    const existing = (
      await tx.client.query(
        `SELECT r.id,r.input,r.membership_id,d.definition FROM ${table(tx, 'tf_workflow_runs')} r JOIN ${table(tx, 'tf_workflow_revisions')} d ON d.workflow_id=r.workflow_id AND d.id=r.revision WHERE r.workflow_id=$1 AND r.request_key=$2`,
        [workflowId, key],
      )
    ).rows[0];
    if (existing) {
      if (
        canonical(
          replayed(payloadSchema.parse(existing.input), definitionSchema.parse(existing.definition).trigger),
        ) !== canonical(replayed(input, trigger)) ||
        existing.membership_id !== membershipId
      )
        throw new WorkflowConflict('request-conflict');
      return { runId: idSchema.parse(existing.id), replayed: true };
    }
    if (!current.enabled || !current.activeRevision) throw new WorkflowConflict('workflow-disabled');
    const counts = z
      .object({ workspace: z.number(), member: z.number(), workflow: z.number(), parked: z.number() })
      .parse(
        (
          await tx.client.query(
            `WITH live AS (SELECT r.membership_id,r.workflow_id,r.sponsorship_id,${parked(tx, 'r')} AS parked FROM ${table(tx, 'tf_workflow_runs')} r WHERE r.status IN ('queued','running','waiting')) SELECT count(*) FILTER (WHERE NOT parked)::integer AS workspace,count(*) FILTER (WHERE NOT parked AND membership_id=$1)::integer AS member,count(*) FILTER (WHERE NOT parked AND workflow_id=$2 AND sponsorship_id IS NOT NULL)::integer AS workflow,count(*) FILTER (WHERE parked AND workflow_id=$2)::integer AS parked FROM live`,
            [membershipId, workflowId],
          )
        ).rows[0],
      );
    // Unattended sources share one sponsor's quota, so one busy workflow must not starve the sponsor's others.
    if (sponsor && counts.workflow >= workflowLimits.workflow) throw new WorkflowLimitReached('workflow');
    if (sponsor && counts.parked >= workflowLimits.parked) throw new WorkflowLimitReached('parked');
    if (counts.member >= workflowLimits.member) throw new WorkflowLimitReached('member');
    if (counts.workspace >= workflowLimits.workspace) throw new WorkflowLimitReached('workspace');
    const runId = randomUUID(),
      scheduledFor = /^(schedule|record):/.test(key) ? scheduledInstant(input) : null;
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_workflow_runs')} (id,workflow_id,revision,request_key,membership_id,input,sponsorship_id,scheduled_for) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        runId,
        workflowId,
        current.activeRevision,
        key,
        membershipId,
        JSON.stringify(input),
        sponsor?.sponsorship_id ?? null,
        scheduledFor,
      ],
    );
    if (sponsor)
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_workflow_run_audience')} (run_id,membership_id) SELECT $1,membership_id FROM ${table(tx, 'tf_workflow_history_audience')} WHERE workflow_id=$2`,
        [runId, workflowId],
      );
    return { runId, replayed: false };
  }
  async function skip(
    tx: WorkflowTransaction,
    workflowId: string,
    revision: string,
    key: string,
    input: z.infer<typeof payloadSchema>,
    reason: 'previous-run-unfinished' | 'missed-occurrences-coalesced' | 'record-values-too-large',
  ) {
    // Workspaces below common version 2 reject the skipped status until the rollout reaches them.
    if (tx.commonVersion < 1) return;
    const sponsor = await workflowSponsor(tx, workflowId);
    const scheduledFor = scheduledInstant(input);
    const inserted = await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_workflow_runs')} (id,workflow_id,revision,request_key,membership_id,input,sponsorship_id,status,error,scheduled_for) VALUES ($1,$2,$3,$4,$5,$6,$7,'skipped',$8,$9) ON CONFLICT (workflow_id,request_key) DO NOTHING RETURNING id`,
      [
        randomUUID(),
        workflowId,
        revision,
        key,
        sponsor.sponsor_membership_id,
        JSON.stringify(input),
        sponsor.sponsorship_id,
        reason,
        scheduledFor,
      ],
    );
    if (inserted.rowCount === 1)
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_workflow_run_audience')} (run_id,membership_id) SELECT $1,membership_id FROM ${table(tx, 'tf_workflow_history_audience')} WHERE workflow_id=$2`,
        [inserted.rows[0].id, workflowId],
      );
  }
  async function start(workspaceId: string, user: string, id: string, value: unknown) {
    const input = startSchema.parse(value);
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      const { runId } = await admit(
        tx,
        idSchema.parse(id),
        `manual:${actor.membershipId}:${input.requestId}`,
        input.input,
        actor.membershipId,
      );
      return { runId };
    });
  }
  async function person(tx: AuthorizationTransaction, membershipId: string | null) {
    if (!membershipId) return null;
    const row = (
      await tx.client.query(
        `SELECT id,user_id AS "userId",'Workspace member' AS name FROM ${table(tx, 'tf_memberships')} WHERE id=$1`,
        [membershipId],
      )
    ).rows[0];
    return row ? workflowPersonSchema.parse(row) : null;
  }
  async function requireDefinitionProvenance(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    workflowId: string,
    revision: string,
  ) {
    for (const source of await protectedSourceClosure(tx, [{ kind: 'workflow-definition', workflowId, revision }]))
      await requireProtectedSource(tx, actor, source);
  }
  async function definition(workspaceId: string, user: string, id: string, value: unknown = {}) {
    const query = definitionQuerySchema.parse(value);
    return transaction(
      workspaceId,
      async tx => {
        const actor = await workflowMember(tx, user);
        await requireGrant(tx, actor.membershipId, id, 'read');
        const current = await read(tx, id, actor.membershipId);
        const revision =
          query.revision === 'saved'
            ? current.revision
            : query.revision === 'active'
              ? current.activeRevision
              : query.revision;
        if (!revision) throw new AccessDenied();
        if (revision !== current.revision && revision !== current.activeRevision) {
          // Old definitions are reachable only through the same audience boundary as their runs.
          const run = (
            await tx.client.query(
              `SELECT r.id FROM ${table(tx, 'tf_workflow_runs')} r WHERE workflow_id=$1 AND revision=$2 AND ((sponsorship_id IS NULL AND membership_id=$3 AND (request_key LIKE 'manual:%' OR request_key LIKE 'event:%')) OR EXISTS (SELECT 1 FROM ${table(tx, 'tf_workflow_run_audience')} a WHERE a.run_id=r.id AND a.membership_id=$3)) ORDER BY created_at DESC LIMIT 1`,
              [id, revision, actor.membershipId],
            )
          ).rows[0];
          if (!run) throw new AccessDenied();
          await requireRunAccess(tx, actor.membershipId, id, run.id, false);
        }
        const row = (
          await tx.client.query(
            `SELECT definition FROM ${table(tx, 'tf_workflow_revisions')} WHERE workflow_id=$1 AND id=$2`,
            [id, revision],
          )
        ).rows[0];
        if (!row) throw new AccessDenied();
        const selected = definitionSchema.parse(row.definition);
        await authorizeSources(tx, selected, actor.membershipId);
        await requireDefinitionProvenance(tx, actor, id, revision);
        return definitionViewSchema.parse({
          workflowId: id,
          revision,
          savedRevision: current.revision,
          activeRevision: current.activeRevision,
          definition: selected,
          actor:
            revision === current.revision || revision === current.activeRevision
              ? await person(tx, current.sponsorMembershipId)
              : null,
          canManage: current.capabilities.manage,
          archived: current.archivedAt !== null,
        });
      },
      'read',
    );
  }
  async function runReceipts(tx: AuthorizationTransaction, actor: HumanActor, runId: string) {
    const rows = (
      await tx.client.query(
        `SELECT s.step_id AS "stepId",s.ordinal,s.status,s.output,s.prompt,(SELECT e->>'kind' FROM jsonb_array_elements(d.definition->'steps') e WHERE e->>'id'=s.step_id LIMIT 1) AS kind,CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(d.definition->'steps') e WHERE e->>'id'=s.step_id AND e->>'kind' IN ('delay','wait-until')) THEN ${utcInstant('s.due_at')} END AS "dueAt" FROM ${table(tx, 'tf_workflow_steps')} s JOIN ${table(tx, 'tf_workflow_runs')} r ON r.id=s.run_id JOIN ${table(tx, 'tf_workflow_revisions')} d ON d.workflow_id=r.workflow_id AND d.id=r.revision WHERE s.run_id=$1 ORDER BY s.ordinal`,
        [runId],
      )
    ).rows;
    const withheldFrom = await unreadableAgentResult(tx, actor, rows);
    return receiptSchema
      .array()
      .parse(rows)
      .map(step =>
        withheldFrom === null || step.ordinal < withheldFrom
          ? step
          : { ...step, output: step.status === 'completed' ? withheldOutput : step.output, prompt: null },
      );
  }
  async function runDetail(workspaceId: string, user: string, id: string, runId: string) {
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      await requireRunAccess(tx, actor.membershipId, id, runId, false);
      const row = (
        await tx.client.query(
          `SELECT r.id,r.workflow_id AS "workflowId",r.revision,r.status,split_part(r.request_key,':',1) AS source,r.input,r.created_at::text AS "createdAt",${utcInstant('r.scheduled_for')} AS "scheduledFor",${utcInstant('r.started_at')} AS "startedAt",${utcInstant('r.finished_at')} AS "finishedAt",r.error,r.membership_id,d.definition FROM ${table(tx, 'tf_workflow_runs')} r JOIN ${table(tx, 'tf_workflow_revisions')} d ON d.workflow_id=r.workflow_id AND d.id=r.revision WHERE r.id=$1 AND r.workflow_id=$2`,
          [runId, id],
        )
      ).rows[0];
      await requireDefinitionProvenance(tx, actor, id, row.revision);
      return runDetailSchema.parse({
        run: { ...runSchema.parse(row), steps: await runReceipts(tx, actor, runId) },
        definition: row.definition,
        actor: await person(tx, row.membership_id),
        canManage: await hasGrant(tx, actor.membershipId, id, 'manage'),
      });
    });
  }
  async function history(workspaceId: string, user: string, id: string, value: unknown = {}) {
    const query = runHistoryQuerySchema.parse(value);
    const [beforeAt, beforeId] = query.before?.split('~') ?? [];
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      await requireGrant(tx, actor.membershipId, id, 'read');
      const runs = async (statuses: readonly string[], limit: number | null) =>
        (
          await tx.client.query(
            `WITH visible AS (SELECT r.* FROM ${table(tx, 'tf_workflow_runs')} r WHERE workflow_id=$1 AND ((sponsorship_id IS NULL AND membership_id=$2 AND (request_key LIKE 'manual:%' OR request_key LIKE 'event:%')) OR EXISTS (SELECT 1 FROM ${table(tx, 'tf_workflow_run_audience')} a WHERE a.run_id=r.id AND a.membership_id=$2))) SELECT id,workflow_id AS "workflowId",revision,status,split_part(request_key,':',1) AS source,input,created_at::text AS "createdAt",${utcInstant('scheduled_for')} AS "scheduledFor",${utcInstant('started_at')} AS "startedAt",${utcInstant('finished_at')} AS "finishedAt",error,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '~' || id AS cursor FROM visible WHERE status=ANY($3::text[]) AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT $6`,
            [id, actor.membershipId, statuses, beforeAt ?? null, beforeId ?? null, limit],
          )
        ).rows;
      const finished = statusSchema.options.filter(
        status => !unfinishedStatuses.some(live => live === status) && status !== 'skipped',
      );
      const pinned = query.status || query.before ? [] : await runs(unfinishedStatuses, null);
      const page = await runs(query.status ? [query.status] : finished, runHistoryPageSize + 1);
      const nextCursor =
        page.length > runHistoryPageSize ? runHistoryCursorSchema.parse(page[runHistoryPageSize - 1].cursor) : null;
      const result = [];
      for (const run of runSchema.array().parse([...pinned, ...page.slice(0, runHistoryPageSize)])) {
        try {
          await requireRunAccess(tx, actor.membershipId, id, run.id, false);
        } catch (error) {
          if (error instanceof AccessDenied) continue;
          throw error;
        }
        result.push({ ...run, steps: await runReceipts(tx, actor, run.id) });
      }
      return { runs: result, nextCursor };
    });
  }
  /** The ordinal of the first agent result the reader cannot see. Later steps can copy that result, so history withholds them too. */
  async function unreadableAgentResult(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    rows: readonly Record<string, unknown>[],
  ) {
    for (const row of rows) {
      if (row.kind !== 'agent' || row.status !== 'completed') continue;
      const output = z.object({ taskId: idSchema }).safeParse(row.output);
      if (
        !output.success ||
        !options.agentResultReadable ||
        !(await options.agentResultReadable(tx, actor, output.data.taskId))
      )
        return z.number().int().parse(row.ordinal);
    }
    return null;
  }
  async function requireRunAccess(
    tx: AuthorizationTransaction,
    membershipId: string,
    workflowId: string,
    runId: string,
    mutate: boolean,
  ) {
    await requireGrant(tx, membershipId, workflowId, mutate ? 'invoke' : 'read');
    const row = (
      await tx.client.query(
        `SELECT r.membership_id,r.sponsorship_id,r.request_key,d.definition FROM ${table(tx, 'tf_workflow_runs')} r JOIN ${table(tx, 'tf_workflow_revisions')} d ON d.workflow_id=r.workflow_id AND d.id=r.revision WHERE r.id=$1 AND r.workflow_id=$2 AND ((r.sponsorship_id IS NULL AND r.membership_id=$3 AND (r.request_key LIKE 'manual:%' OR r.request_key LIKE 'event:%')) OR EXISTS (SELECT 1 FROM ${table(tx, 'tf_workflow_run_audience')} a WHERE a.run_id=r.id AND a.membership_id=$3))`,
        [idSchema.parse(runId), idSchema.parse(workflowId), membershipId],
      )
    ).rows[0];
    if (!row) throw new AccessDenied();
    if (mutate) {
      await requireGrant(tx, idSchema.parse(row.membership_id), workflowId, 'invoke');
      if (row.sponsorship_id) {
        const sponsor = await requireSponsor(tx, workflowId);
        if (sponsor.sponsorship_id !== row.sponsorship_id || sponsor.sponsor_membership_id !== row.membership_id)
          throw new AccessDenied();
      }
    }
    const definition = definitionSchema.parse(row.definition);
    await authorizeSources(tx, definition, membershipId);
    if (mutate) await authorizeSources(tx, definition, idSchema.parse(row.membership_id));
  }
  async function sponsorship(workspaceId: string, user: string, id: string, value: unknown) {
    const input = sponsorshipSchema.parse(value);
    return wakeAfter(workspaceId, async (tx, woken) => {
      const actor = await workflowMember(tx, user);
      await requireGrant(tx, actor.membershipId, id, 'manage');
      await requireGrant(tx, input.sponsorMembershipId, id, 'invoke');
      await requireUnarchived(tx, id);
      const current = await read(tx, id, actor.membershipId);
      const trigger = current.definition.trigger;
      if (trigger.kind === 'record' || trigger.kind === 'row')
        await requireRecordAudience(tx, trigger, [input.sponsorMembershipId, ...input.historyAudience]);
      await requireTableStepAuthority(tx, current.definition, input.sponsorMembershipId, input.historyAudience);
      await authorizeSources(tx, current.definition, input.sponsorMembershipId);
      for (const recipient of input.historyAudience) {
        await requireGrant(tx, recipient, id, 'read');
        await authorizeSources(tx, current.definition, recipient);
      }
      if (
        current.sponsorMembershipId === input.sponsorMembershipId &&
        current.sponsorshipAccepted &&
        canonical([...current.historyAudience].sort()) === canonical([...new Set(input.historyAudience)].sort())
      )
        return current;
      await tx.client.query(`DELETE FROM ${table(tx, 'tf_workflow_history_audience')} WHERE workflow_id=$1`, [id]);
      for (const recipient of new Set(input.historyAudience))
        await tx.client.query(`INSERT INTO ${table(tx, 'tf_workflow_history_audience')} VALUES ($1,$2)`, [
          id,
          recipient,
        ]);
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_workflows')} SET sponsor_membership_id=$2,sponsorship_id=$3,sponsorship_revision=revision,enabled=false,next_run_at=NULL,generation=generation+1 WHERE id=$1`,
        [id, input.sponsorMembershipId, input.sponsorMembershipId === actor.membershipId ? randomUUID() : null],
      );
      await liveRuns(tx, id, woken);
      await tx.client.query(`UPDATE ${table(tx, 'tf_provider_polls')} SET fence=$2 WHERE workflow_id=$1`, [
        id,
        randomUUID(),
      ]);
      await tx.client.query(`DELETE FROM ${table(tx, 'tf_provider_events')} WHERE workflow_id=$1 AND NOT admitted`, [
        id,
      ]);
      await auditWorkflow(tx, actor.membershipId, 'workflow.sponsor', id);
      return read(tx, id, actor.membershipId);
    });
  }
  async function acceptSponsorship(workspaceId: string, user: string, id: string, value: unknown) {
    const input = acceptSponsorshipSchema.parse(value);
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      await requireGrant(tx, actor.membershipId, id, 'invoke');
      await requireUnarchived(tx, id);
      const current = await read(tx, id, actor.membershipId);
      if (current.sponsorMembershipId !== actor.membershipId || !current.historyAudience.length)
        throw new AccessDenied();
      const trigger = current.definition.trigger;
      if (trigger.kind === 'record' || trigger.kind === 'row')
        await requireRecordAudience(tx, trigger, [actor.membershipId, ...current.historyAudience]);
      await requireTableStepAuthority(tx, current.definition, actor.membershipId, current.historyAudience);
      await authorizeSources(tx, current.definition, actor.membershipId);
      for (const recipient of current.historyAudience) {
        await requireGrant(tx, recipient, id, 'read');
        await authorizeSources(tx, current.definition, recipient);
      }
      if (!current.sponsorshipAccepted) {
        if (input.expectedGeneration !== current.generation) throw new WorkflowConflict('stale-generation');
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_workflows')} SET sponsorship_id=$2,sponsorship_revision=revision,generation=generation+1 WHERE id=$1`,
          [id, randomUUID()],
        );
        await auditWorkflow(tx, actor.membershipId, 'workflow.sponsor.accept', id);
      }
      return read(tx, id, actor.membershipId);
    });
  }
  async function respond(workspaceId: string, user: string, workflowId: string, runId: string, value: unknown) {
    const input = z
      .strictObject({ stepId: z.string().max(48), responseId: idSchema, output: payloadSchema })
      .parse(value);
    return wakeAfter(workspaceId, async (tx, woken) => {
      const actor = await workflowMember(tx, user);
      await requireRunAccess(tx, actor.membershipId, workflowId, runId, true);
      const row = (
        await tx.client.query(
          `SELECT s.*,r.status AS run_status,r.workflow_id,(s.due_at>clock_timestamp()) AS live FROM ${table(tx, 'tf_workflow_steps')} s JOIN ${table(tx, 'tf_workflow_runs')} r ON r.id=s.run_id WHERE s.run_id=$1 AND s.step_id=$2 AND r.workflow_id=$3`,
          [idSchema.parse(runId), input.stepId, idSchema.parse(workflowId)],
        )
      ).rows[0];
      if (!row || !row.prompt) throw new AccessDenied();
      if (row.response_id === input.responseId && canonical(row.output) === canonical(input.output))
        return { saved: true };
      if (row.status !== 'waiting' || !row.live || !['waiting', 'running'].includes(row.run_status))
        throw new WorkflowConflict('wait-closed');
      const current = await read(tx, workflowId);
      if (!current.enabled) throw new WorkflowConflict('workflow-disabled');
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_workflow_steps')} SET status='completed',output=$3,response_id=$4 WHERE run_id=$1 AND step_id=$2`,
        [runId, input.stepId, JSON.stringify(input.output), input.responseId],
      );
      await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='running' WHERE id=$1`, [runId]);
      await auditWorkflow(tx, actor.membershipId, 'workflow.respond', runId);
      woken.add(idSchema.parse(runId));
      return { saved: true };
    });
  }
  async function cancel(workspaceId: string, user: string, workflowId: string, runId: string) {
    return wakeAfter(workspaceId, async (tx, woken) => {
      const actor = await workflowMember(tx, user);
      await requireRunAccess(tx, actor.membershipId, workflowId, runId, true);
      const result = await tx.client.query(
        `UPDATE ${table(tx, 'tf_workflow_runs')} SET status='cancelled' WHERE id=$1 AND workflow_id=$2 AND status IN ('queued','running','waiting') RETURNING id`,
        [idSchema.parse(runId), idSchema.parse(workflowId)],
      );
      if (
        !result.rowCount &&
        !(
          await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_workflow_runs')} WHERE id=$1 AND workflow_id=$2`, [
            runId,
            workflowId,
          ])
        ).rowCount
      )
        throw new AccessDenied();
      if (result.rowCount) woken.add(idSchema.parse(runId));
      await auditWorkflow(tx, actor.membershipId, 'workflow.cancel', runId);
      return { saved: true };
    });
  }
  async function webhookKey(workspaceId: string, user: string, id: string, value: unknown) {
    const input = webhookKeySchema.parse(value);
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user),
        current = await read(tx, id);
      await requireGrant(tx, actor.membershipId, id, 'manage');
      if (current.definition.trigger.kind !== 'webhook' && current.activeTrigger?.kind !== 'webhook')
        throw new WorkflowConflict('trigger-not-webhook');
      let key: string | null = null;
      await administrativeCommand(
        tx,
        {
          ...input,
          generation: current.generation,
          membershipId: actor.membershipId,
          operation: 'webhook-key',
          target: current.id,
          request: input,
        },
        async () => {
          await requireUnarchived(tx, id);
          const rotation = webhookRotation(tx);
          if (!rotation && input.mode !== 'bearer') throw new WorkflowConflict('webhook-signing-unavailable');
          let issued;
          try {
            issued = issueWebhookKey(cipher, workspaceId, id, current.generation + 1, input.mode, input.secret);
          } catch {
            throw new WorkflowConflict('webhook-signing-unavailable');
          }
          const bearerDigest = issued.stored.mode === 'bearer' ? issued.stored.digest : null;
          if (!rotation)
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_workflows')} SET webhook_digest=$2,generation=generation+1 WHERE id=$1`,
              [id, bearerDigest],
            );
          else {
            const previous =
              input.graceSeconds > 0
                ? currentKey(
                    (
                      await tx.client.query(
                        `SELECT webhook_digest,webhook_secret FROM ${table(tx, 'tf_workflows')} WHERE id=$1`,
                        [id],
                      )
                    ).rows[0],
                  )
                : null;
            const secret =
              issued.stored.mode !== 'bearer'
                ? { mode: issued.stored.mode, generation: issued.stored.generation, envelope: issued.stored.envelope }
                : null;
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_workflows')} SET webhook_digest=$2,webhook_secret=$3,webhook_previous=$4,webhook_previous_expires_at=CASE WHEN $4::jsonb IS NULL THEN NULL ELSE clock_timestamp()+$5*interval '1 second' END,generation=generation+1 WHERE id=$1`,
              [
                id,
                bearerDigest,
                secret && JSON.stringify(secret),
                previous && JSON.stringify(previous),
                input.graceSeconds,
              ],
            );
          }
          key = issued.key;
          await auditWorkflow(tx, actor.membershipId, 'workflow.webhook.rotate', id);
        },
      );
      return { workflow: await read(tx, id, actor.membershipId), key };
    });
  }
  async function revokePreviousWebhookKey(workspaceId: string, user: string, id: string, value: unknown) {
    const input = commandSchema.parse(value);
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user),
        current = await read(tx, id);
      await requireGrant(tx, actor.membershipId, id, 'manage');
      if (!webhookRotation(tx)) throw new WorkflowConflict('webhook-signing-unavailable');
      await administrativeCommand(
        tx,
        {
          ...input,
          generation: current.generation,
          membershipId: actor.membershipId,
          operation: 'webhook-key-revoke',
          target: current.id,
          request: input,
        },
        async () => {
          await requireUnarchived(tx, id);
          if (!current.webhookPrevious) return;
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_workflows')} SET webhook_previous=NULL,webhook_previous_expires_at=NULL,generation=generation+1 WHERE id=$1`,
            [id],
          );
          await auditWorkflow(tx, actor.membershipId, 'workflow.webhook.revoke', id);
        },
      );
      return read(tx, id, actor.membershipId);
    });
  }
  function currentKey(
    row: { webhook_digest: string | null; webhook_secret: unknown } | undefined,
  ): StoredWebhookKey | null {
    if (row?.webhook_digest) return { mode: 'bearer', digest: z.string().parse(row.webhook_digest) };
    if (row?.webhook_secret) {
      const secret = z.record(z.string(), z.unknown()).parse(row.webhook_secret);
      return storedWebhookKeySchema.parse({ mode: secret.mode ?? 'signed', ...secret });
    }
    return null;
  }
  async function activeWebhook(tx: WorkflowTransaction, id: string, columns = '') {
    const row = (
      await tx.client.query(
        `SELECT ${columns}r.definition FROM ${table(tx, 'tf_workflows')} w JOIN ${table(tx, 'tf_workflow_revisions')} r ON r.workflow_id=w.id AND r.id=w.active_revision WHERE w.id=$1 AND w.enabled`,
        [idSchema.parse(id)],
      )
    ).rows[0];
    const trigger = row ? definitionSchema.parse(row.definition).trigger : null;
    return row && trigger?.kind === 'webhook' ? { row, trigger } : null;
  }
  async function webhook(workspaceId: string, id: string, delivery: WebhookDelivery) {
    const proofs = webhookProof(delivery);
    if (!proofs.length) throw new WebhookRejected('key-missing');
    const outcome = await transaction(workspaceId, async tx => {
      const rotation = webhookRotation(tx);
      const active = await activeWebhook(
        tx,
        id,
        `w.webhook_digest,${rotation ? `w.webhook_secret,CASE WHEN w.webhook_previous_expires_at>clock_timestamp() THEN w.webhook_previous END AS webhook_previous,` : 'NULL AS webhook_secret,NULL AS webhook_previous,'}extract(epoch FROM clock_timestamp())::float8 AS now,`,
      );
      if (!active) throw new WebhookRejected('workflow-inactive');
      const { row, trigger } = active;
      const keys = [
        currentKey(row),
        row.webhook_previous ? storedWebhookKeySchema.parse(row.webhook_previous) : null,
      ].filter(key => key !== null);
      const proof = matchWebhookKey(cipher, workspaceId, id, keys, proofs);
      if (!proof) throw new WebhookRejected('key-rejected');
      if (proof.kind === 'signed' || proof.kind === 'stripe') {
        if (Math.abs(z.number().parse(row.now) - proof.timestamp) > tolerance)
          throw new WorkflowConflict('webhook-signature-expired');
        // A signature stays replayable only while its timestamp is inside the window, which closes at most twice the tolerance after it was first seen.
        await tx.client.query(
          `DELETE FROM ${table(tx, 'tf_workflow_webhook_signatures')} WHERE workflow_id=$1 AND received_at<clock_timestamp()-$2*interval '1 second'`,
          [id, tolerance * 2],
        );
        const recorded = await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_workflow_webhook_signatures')} (workflow_id,signature) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [id, proof.signature],
        );
        if (recorded.rowCount !== 1) throw new WorkflowConflict('webhook-signature-replayed');
        // A refusal these exact bytes would always get keeps the signature spent, so a captured request cannot be resent for free.
        // A run limit or an outage rolls it back, so the sender can retry the same request.
        await tx.client.query('SAVEPOINT webhook_admission');
        try {
          return { run: await receive(tx, id, trigger, delivery.body, delivery.headers) };
        } catch (failure) {
          if (
            failure instanceof WorkflowLimitReached ||
            !(failure instanceof WorkflowConflict || failure instanceof z.ZodError)
          )
            throw failure;
          await tx.client.query('ROLLBACK TO SAVEPOINT webhook_admission');
          return { failure };
        }
      }
      return { run: await receive(tx, id, trigger, delivery.body, delivery.headers) };
    });
    if ('failure' in outcome) throw outcome.failure;
    return outcome.run;
  }
  /** Admits a delivery whose sender is already verified, as the sponsor, under the trigger's request identity. */
  async function receive(
    tx: WorkflowTransaction,
    id: string,
    trigger: Extract<Trigger, { kind: 'webhook' }>,
    value: unknown,
    headers: WebhookHeaders,
  ) {
    if (!trigger.payload) {
      const input = startSchema.parse(value);
      return admit(tx, id, `webhook:${input.requestId}`, input.input, null);
    }
    const body = payloadSchema.parse(value),
      { dedupe } = trigger.payload;
    const copied = trigger.payload.headers?.length
      ? Object.fromEntries(
          trigger.payload.headers
            .filter(name => !isSecretHeader(name))
            .flatMap(name => {
              const sent = sentHeader(headers, name);
              return sent === undefined ? [] : [[name, sent]];
            }),
        )
      : null;
    const dedupeValue =
      dedupe.source === 'hash'
        ? canonical(body)
        : dedupe.source === 'header'
          ? z.string().min(1).max(512).parse(sentHeader(headers, dedupe.name))
          : canonical(z.union([z.string().min(1).max(512), z.number()]).parse(bodyAt(body, dedupe.path)));
    const input = copied ? payloadSchema.parse({ body, headers: copied }) : body;
    // A provider redelivers one event with fresh per-attempt headers, so only the body decides a replay conflict.
    // Each run's input shape follows the revision that admitted it, which may copy different headers.
    const sentBody = (run: z.infer<typeof payloadSchema>, admittedBy: Trigger | null) =>
      admittedBy?.kind === 'webhook' &&
      admittedBy.payload?.headers?.length &&
      run !== null &&
      typeof run === 'object' &&
      !Array.isArray(run)
        ? run.body
        : run;
    return admit(tx, id, `webhook:${dedupe.source}:${digest(canonical([dedupe, dedupeValue]))}`, input, null, sentBody);
  }
  /** Sends a sample shaped for the active trigger through the same admission as a verified delivery. The server cannot present a bearer key it stores only as a hash, so the manager's grant stands in for the key. */
  async function testWebhook(workspaceId: string, user: string, id: string, value: unknown) {
    const input = webhookTestSchema.parse(value);
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      await requireGrant(tx, actor.membershipId, id, 'manage');
      const active = await activeWebhook(tx, id);
      if (!active) throw new WorkflowConflict('workflow-inactive');
      const sample = webhookSample(active.trigger, input.requestId);
      return receive(tx, id, active.trigger, sample.body, sample.headers);
    });
  }
  type DeliveryRecord = {
    status: number;
    outcome: string;
    test: boolean;
    runId: string | null;
    bodyBytes: number | null;
  } & ({ requestId: string | null } | { sent: { body: unknown; headers: WebhookHeaders } });
  /** Keeps a bounded log entry for a delivery attempt, including rejected ones, in its own transaction so a rolled-back delivery still leaves a trace. Never stores the body or a credential. */
  async function recordWebhookDelivery(workspaceId: string, id: string, record: DeliveryRecord) {
    const workflowId = idSchema.parse(id),
      outcome = webhookOutcomeSchema.parse(record.outcome);
    // Logging decides no access, so unverified callers' entries must not queue behind the workspace authorization lock.
    await runtime.transaction(idSchema.parse(workspaceId), commonCompatibility, async tx => {
      if (!webhookLog(tx)) return;
      let requestId: string | null;
      if ('requestId' in record) requestId = record.requestId;
      else {
        const active = (
          await tx.client.query(
            `SELECT r.definition FROM ${table(tx, 'tf_workflows')} w JOIN ${table(tx, 'tf_workflow_revisions')} r ON r.workflow_id=w.id AND r.id=w.active_revision WHERE w.id=$1`,
            [workflowId],
          )
        ).rows[0];
        requestId = deliveryRequestId(
          active ? definitionSchema.parse(active.definition).trigger : null,
          record.sent.body,
          record.sent.headers,
        );
      }
      const deliveries = table(tx, 'tf_workflow_webhook_deliveries');
      const inserted = await tx.client.query(
        `INSERT INTO ${deliveries} (id,workflow_id,status,outcome,request_id,body_bytes,run_id,test) SELECT $1,w.id,$3,$4,$5,$6,$7,$8 FROM ${table(tx, 'tf_workflows')} w WHERE w.id=$2`,
        [randomUUID(), workflowId, record.status, outcome, requestId, record.bodyBytes, record.runId, record.test],
      );
      if (inserted.rowCount)
        await tx.client.query(
          `DELETE FROM ${deliveries} WHERE workflow_id=$1 AND (received_at<clock_timestamp()-$2*interval '1 day' OR id NOT IN (SELECT id FROM ${deliveries} WHERE workflow_id=$1 ORDER BY received_at DESC,id DESC LIMIT $3))`,
          [workflowId, webhookDeliveryRetention.days, webhookDeliveryRetention.count],
        );
    });
  }
  async function webhookDeliveries(workspaceId: string, user: string, id: string) {
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      await requireGrant(tx, actor.membershipId, id, 'manage');
      if (!webhookLog(tx)) return webhookDeliveryLogSchema.parse({ available: false, deliveries: [] });
      return webhookDeliveryLogSchema.parse({
        available: true,
        deliveries: (
          await tx.client.query(
            `SELECT d.id,${utcInstant('d.received_at')} AS "receivedAt",d.status,d.outcome,CASE WHEN d.run_id IS NULL OR v.visible THEN d.request_id END AS "requestId",d.body_bytes AS "bodyBytes",d.run_id IS NOT NULL AS "runStarted",CASE WHEN v.visible THEN d.run_id END AS "runId",d.test FROM ${table(tx, 'tf_workflow_webhook_deliveries')} d CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM ${table(tx, 'tf_workflow_run_audience')} a WHERE a.run_id=d.run_id AND a.membership_id=$2) AS visible) v WHERE d.workflow_id=$1 AND d.received_at>=clock_timestamp()-$3*interval '1 day' ORDER BY d.received_at DESC,d.id DESC LIMIT $4`,
            [idSchema.parse(id), actor.membershipId, webhookDeliveryRetention.days, webhookDeliveryRetention.count],
          )
        ).rows,
      });
    });
  }
  async function event(workspaceId: string, user: string, id: string, eventName: string, value: unknown) {
    const input = startSchema.parse(value);
    return transaction(workspaceId, async tx => {
      const actor = await workflowMember(tx, user);
      await requireGrant(tx, actor.membershipId, id, 'invoke');
      const row = (
        await tx.client.query(
          `SELECT r.definition FROM ${table(tx, 'tf_workflows')} w JOIN ${table(tx, 'tf_workflow_revisions')} r ON r.workflow_id=w.id AND r.id=w.active_revision WHERE w.id=$1 AND w.enabled`,
          [idSchema.parse(id)],
        )
      ).rows[0];
      const trigger = row ? definitionSchema.parse(row.definition).trigger : null;
      if (trigger?.kind !== 'event' || trigger.name !== eventName) throw new AccessDenied();
      const { runId } = await admit(
        tx,
        id,
        `event:${actor.membershipId}:${input.requestId}`,
        input.input,
        actor.membershipId,
      );
      return { runId };
    });
  }
  async function fireRecordOccurrences(
    tx: WorkflowTransaction,
    workflowId: string,
    revision: string,
    trigger: RecordTrigger,
    sweptAt: Date,
    sweepDue: string,
  ) {
    return sweepTable(tx, workflowId, revision, sweptAt, async sponsor => {
      const generation = await recordSource(tx, trigger, sponsor);
      await reconcileRecordOccurrences(tx, workflowId, revision, trigger, generation, sweepDue);
      const missed = await settleMissedRecordOccurrences(tx, workflowId, revision, sweptAt);
      if (missed)
        await skip(
          tx,
          workflowId,
          revision,
          `record:${revision}:missed:${sweptAt.toISOString()}`,
          { tableId: trigger.tableId, ...missed },
          'missed-occurrences-coalesced',
        );
      for (const occurrence of await dueRecordOccurrences(tx, workflowId, revision, sweptAt)) {
        const run = await recordRunInput(tx, generation, trigger, occurrence),
          key = `record:${revision}:${occurrence.recordId}:${occurrence.dueAt}`;
        if (run?.kind === 'run') await admit(tx, workflowId, key, run.input, null);
        if (run?.kind === 'too-large') await skip(tx, workflowId, revision, key, run.input, 'record-values-too-large');
        await markRecordOccurrenceFired(tx, workflowId, revision, occurrence);
      }
    });
  }
  async function fireRowChanges(
    tx: WorkflowTransaction,
    workflowId: string,
    revision: string,
    trigger: RowTrigger,
    sweptAt: Date,
  ) {
    if (tx.commonVersion < rowTriggerCommonVersion) return 'unavailable';
    try {
      const sponsor = (await requireSponsor(tx, workflowId)).sponsor_membership_id;
      const generation = await rowSource(tx, trigger, sponsor);
      for (const change of await dueRowChanges(tx, workflowId, revision)) {
        const run = await rowRunInput(tx, workflowId, revision, generation, trigger, change),
          key = `row:${revision}:${change.historyId}`;
        if (run.kind === 'blocked') {
          await blockRowChange(tx, workflowId, revision, change, run.reason);
          continue;
        }
        if (run.kind === 'ignored') {
          await settleRowChange(tx, workflowId, revision, change, 'ignored');
          continue;
        }
        await tx.client.query('SAVEPOINT row_admission');
        try {
          const admitted = await admit(tx, workflowId, key, run.input, null);
          await settleRowChange(tx, workflowId, revision, change, 'admitted', admitted.runId);
          await tx.client.query('RELEASE SAVEPOINT row_admission');
        } catch (error) {
          await tx.client.query('ROLLBACK TO SAVEPOINT row_admission');
          await tx.client.query('RELEASE SAVEPOINT row_admission');
          if (!(error instanceof WorkflowLimitReached)) throw error;
          await blockRowChange(tx, workflowId, revision, change, 'capacity');
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_workflows')} SET next_run_at=$2::timestamptz+interval '1 minute' WHERE id=$1`,
            [workflowId, sweptAt.toISOString()],
          );
          return error.scope === 'workspace' ? 'workspace-limit' : 'limited';
        }
      }
    } catch (error) {
      if (error instanceof AccessDenied) {
        await disableAutomatically(tx, workflowId, 'workflow.disable.sponsor-access-lost');
        return 'disabled';
      }
      if (error instanceof WorkflowConflict && error.message === 'record-field-unavailable') {
        await disableAutomatically(tx, workflowId, 'workflow.disable.record-field-unavailable');
        return 'disabled';
      }
      throw error;
    }
    await tx.client.query(
      `UPDATE ${table(tx, 'tf_workflows')} SET next_run_at=$2::timestamptz+interval '1 minute' WHERE id=$1`,
      [workflowId, sweptAt.toISOString()],
    );
    return 'fired';
  }
  /** Reads a table trigger's source as its sponsor, then schedules the next sweep at the earliest waiting occurrence, or a minute out to pick up edits. */
  async function sweepTable(
    tx: WorkflowTransaction,
    workflowId: string,
    revision: string,
    sweptAt: Date,
    fire: (sponsor: string) => Promise<void>,
  ) {
    try {
      await fire((await requireSponsor(tx, workflowId)).sponsor_membership_id);
    } catch (error) {
      if (error instanceof AccessDenied) {
        await disableAutomatically(tx, workflowId, 'workflow.disable.sponsor-access-lost');
        return 'disabled';
      }
      if (error instanceof WorkflowConflict && error.message === 'record-field-unavailable') {
        await disableAutomatically(tx, workflowId, 'workflow.disable.record-field-unavailable');
        return 'disabled';
      }
      // Unfired occurrences stay due, so the next sweep retries them once a slot frees. This sweep read the table, so it marks the read.
      if (error instanceof WorkflowLimitReached) {
        await tx.client.query(`UPDATE ${table(tx, 'tf_workflows')} SET next_run_at=$2 WHERE id=$1`, [
          workflowId,
          sweptAt.toISOString(),
        ]);
        return error.scope === 'workspace' ? 'workspace-limit' : 'limited';
      }
      throw error;
    }
    await tx.client.query(`UPDATE ${table(tx, 'tf_workflows')} SET next_run_at=$2 WHERE id=$1`, [
      workflowId,
      await nextRecordSweep(tx, workflowId, revision, sweptAt),
    ]);
    return 'fired';
  }
  async function admitProviderEvent(tx: WorkflowTransaction, workflowId: string, event: Record<string, unknown>) {
    const trigger = definitionSchema.parse(event.definition).trigger;
    if (trigger.kind !== 'provider') return 'ignored';
    try {
      await admit(
        tx,
        workflowId,
        `provider:${idSchema.parse(event.revision)}:${z.string().parse(event.event_key)}`,
        payloadSchema.parse(event.payload),
        null,
      );
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_provider_events')} SET admitted=true WHERE workflow_id=$1 AND revision=$2 AND event_key=$3`,
        [workflowId, event.revision, event.event_key],
      );
    } catch (error) {
      if (error instanceof AccessDenied) {
        await disableAutomatically(tx, workflowId, 'workflow.disable.sponsor-access-lost');
        return 'disabled';
      }
      if (error instanceof WorkflowLimitReached) return error.scope === 'workspace' ? 'workspace-limit' : 'limited';
      throw error;
    }
    return 'admitted';
  }
  async function fireSchedule(tx: WorkflowTransaction, row: Record<string, unknown>, sweptAt: Date) {
    const trigger = definitionSchema.parse(row.definition).trigger;
    const workflowId = idSchema.parse(row.id),
      revision = idSchema.parse(row.revision),
      scheduledFor = z.iso.datetime().parse(row.scheduled_for);
    if (trigger.kind === 'record')
      return fireRecordOccurrences(tx, workflowId, revision, trigger, sweptAt, scheduledFor);
    if (trigger.kind === 'row') return fireRowChanges(tx, workflowId, revision, trigger, sweptAt);
    const due = z.string().parse(row.due);
    const key = trigger.kind === 'once' ? `schedule:${revision}:${due}` : `schedule:${due}`;
    const overlapping =
      (trigger.kind === 'cron' || trigger.kind === 'interval') &&
      (
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_workflow_runs')} WHERE workflow_id=$1 AND request_key LIKE 'schedule:%' AND status IN ('queued','running','waiting') LIMIT 1`,
          [workflowId],
        )
      ).rowCount === 1;
    const missed = missedOccurrences(trigger, new Date(scheduledFor), sweptAt);
    try {
      if (overlapping) {
        await requireSponsor(tx, workflowId);
        await skip(
          tx,
          workflowId,
          revision,
          key,
          missed ? { ...missed, scheduledFor, missedCount: missed.missedCount + 1 } : { scheduledFor },
          'previous-run-unfinished',
        );
      } else {
        await admit(tx, workflowId, key, { scheduledFor }, null);
        if (missed) await skip(tx, workflowId, revision, `${key}:missed`, missed, 'missed-occurrences-coalesced');
        // The admitted run records the revocation in history as blocked; disabling stops later occurrences from repeating it.
        await requireSponsor(tx, workflowId);
      }
    } catch (error) {
      if (error instanceof AccessDenied) {
        await disableAutomatically(tx, workflowId, 'workflow.disable.sponsor-access-lost');
        return 'disabled';
      }
      if (error instanceof WorkflowLimitReached) return error.scope === 'workspace' ? 'workspace-limit' : 'limited';
      throw error;
    }
    const intervalAnchor = trigger.kind === 'interval' ? new Date(missed?.missedThrough ?? scheduledFor) : sweptAt;
    await tx.client.query(`UPDATE ${table(tx, 'tf_workflows')} SET next_run_at=$2 WHERE id=$1`, [
      workflowId,
      trigger.kind === 'once' ? null : nextOccurrence(trigger, intervalAnchor),
    ]);
    return 'fired';
  }
  /** Runs one workflow's share of the sweep so an unexpected error, even one that aborts the SQL transaction, costs only that workflow. */
  async function isolated<T>(
    tx: WorkflowTransaction,
    workflowId: string,
    work: () => Promise<T>,
  ): Promise<T | 'failed'> {
    await tx.client.query('SAVEPOINT due_workflow');
    try {
      const result = await work();
      await tx.client.query('RELEASE SAVEPOINT due_workflow');
      return result;
    } catch (error) {
      // A lost connection or an expired transaction cannot roll back to the savepoint, and then the sweep must fail as a whole.
      try {
        await tx.client.query('ROLLBACK TO SAVEPOINT due_workflow');
      } catch {
        throw error;
      }
      await tx.client.query('RELEASE SAVEPOINT due_workflow');
      await auditWorkflow(tx, 'system:workflow-sweep', 'workflow.sweep-failed', workflowId);
      return 'failed';
    }
  }
  async function due(workspaceId: string) {
    return transaction(workspaceId, async tx => {
      // A sponsor or workflow at its run limit waits without holding admission slots that others could use.
      const belowRunLimits = `w.sponsor_membership_id NOT IN (SELECT r.membership_id FROM ${table(tx, 'tf_workflow_runs')} r WHERE r.status IN ('queued','running','waiting') AND r.membership_id IS NOT NULL AND NOT ${parked(tx, 'r')} GROUP BY r.membership_id HAVING count(*)>=$1)
        AND w.id NOT IN (SELECT r.workflow_id FROM ${table(tx, 'tf_workflow_runs')} r WHERE r.status IN ('queued','running','waiting') AND r.sponsorship_id IS NOT NULL GROUP BY r.workflow_id HAVING count(*) FILTER (WHERE NOT ${parked(tx, 'r')})>=$2 OR count(*) FILTER (WHERE ${parked(tx, 'r')})>=$3)
        AND w.id NOT IN (SELECT e.subject_id FROM ${table(tx, 'tf_audit_events')} e WHERE e.operation='workflow.sweep-failed' AND e.created_at>clock_timestamp()-interval '${failedSweepRetry}')`;
      const events = (
        await tx.client.query(
          `SELECT e.workflow_id,e.revision,e.event_key,e.payload,r.definition FROM ${table(tx, 'tf_provider_events')} e JOIN ${table(tx, 'tf_workflows')} w ON w.id=e.workflow_id AND w.active_revision=e.revision JOIN ${table(tx, 'tf_workflow_revisions')} r ON r.workflow_id=w.id AND r.id=e.revision WHERE w.enabled AND NOT e.admitted AND ${belowRunLimits} ORDER BY e.created_at,e.event_key LIMIT 20`,
          [workflowLimits.member, workflowLimits.workflow, workflowLimits.parked],
        )
      ).rows;
      const failed = new Set<string>();
      for (const event of events) {
        const workflowId = idSchema.parse(event.workflow_id);
        if (failed.has(workflowId)) continue;
        const outcome = await isolated(tx, workflowId, () => admitProviderEvent(tx, workflowId, event));
        if (outcome === 'failed') failed.add(workflowId);
        if (outcome === 'workspace-limit') break;
      }
      const sweptAt = await databaseNow(tx);
      const schedules = (
        await tx.client.query(
          `SELECT w.id,w.active_revision AS revision,w.next_run_at::text AS due,${utcInstant('w.next_run_at')} AS scheduled_for,r.definition FROM ${table(tx, 'tf_workflows')} w JOIN ${table(tx, 'tf_workflow_revisions')} r ON r.workflow_id=w.id AND r.id=w.active_revision WHERE w.enabled AND w.next_run_at<=$4::timestamptz AND ${belowRunLimits} ORDER BY w.next_run_at,w.id LIMIT 20`,
          [workflowLimits.member, workflowLimits.workflow, workflowLimits.parked, sweptAt.toISOString()],
        )
      ).rows;
      for (const row of schedules) {
        const workflowId = idSchema.parse(row.id);
        if ((await isolated(tx, workflowId, () => fireSchedule(tx, row, sweptAt))) === 'workspace-limit') break;
      }
      // A parked run needs no redispatch until its due time, when it stops counting as parked.
      const rows = (
        await tx.client.query(
          `SELECT r.id FROM ${table(tx, 'tf_workflow_runs')} r WHERE r.status IN ('queued','running','waiting') ORDER BY ${parked(tx, 'r')},r.dispatched_at NULLS FIRST,r.created_at,r.id LIMIT 20`,
        )
      ).rows;
      const result = rows.map(row => workSchema.parse({ workspaceId, runId: row.id }));
      for (const work of result)
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_workflow_runs')} SET dispatched_at=clock_timestamp() WHERE id=$1`,
          [work.runId],
        );
      return result;
    });
  }
  // A run marked running sleeps only when its wake signal was lost, so the sweep wakes it again.
  async function resumable(workspaceId: string) {
    return transaction(workspaceId, async tx => {
      const slack =
        tx.commonVersion >= 1
          ? `OR r.status='waiting' AND EXISTS (
        SELECT 1 FROM ${table(tx, 'tf_workflow_steps')} s
        JOIN ${table(tx, 'tf_workflow_revisions')} revision ON revision.workflow_id=r.workflow_id AND revision.id=r.revision
        LEFT JOIN ${table(tx, 'tf_slack_workflow_actions')} o ON o.run_id=s.run_id AND o.step_id=s.step_id
        LEFT JOIN ${table(tx, 'tf_slack_actions')} a ON a.id=o.id
        LEFT JOIN ${table(tx, 'tf_slack_action_effects')} e ON e.action_id=a.id
        LEFT JOIN ${table(tx, 'tf_slack_action_decisions')} d ON d.action_id=a.id
        LEFT JOIN ${table(tx, 'tf_slack_action_cards')} c ON c.action_id=a.id
        WHERE s.run_id=r.id AND s.status='waiting'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(revision.definition->'steps') step WHERE step->>'id'=s.step_id AND step->>'kind'='slack-message')
          AND (a.id IS NULL OR s.output->>'status'='preparing' OR d.action_id IS NOT NULL
            OR a.expires_at<=clock_timestamp() OR e.state<>'pending' AND e.next_attempt_at<=clock_timestamp()
            OR e.state='pending' AND (c.action_id IS NULL OR c.state='retry' AND c.next_attempt_at<=clock_timestamp()))
      )`
          : '';
      return (
        await tx.client.query(
          `SELECT r.id FROM ${table(tx, 'tf_workflow_runs')} r WHERE r.status='running' ${slack} ORDER BY r.created_at,r.id LIMIT 20`,
        )
      ).rows.map(row => workSchema.parse({ workspaceId, runId: row.id }));
    });
  }
  type CodeWork = { kind: 'code'; job: SnippetJob };
  type AgentWork = {
    kind: 'agent';
    workspaceId: string;
    userId: string;
    taskId?: string | undefined;
    request?:
      | {
          requestId: string;
          agentId: string;
          text: string;
          limits: { toolCalls: number; activeMilliseconds: number; credits: number };
        }
      | undefined;
  };
  type HttpWork = {
    kind: 'http';
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string | undefined;
  };
  type SlackWork = { kind: 'slack'; workspaceId: string; runId: string; stepId: string; actionId: string };
  const isProgress = (work: Progress | CodeWork | AgentWork | HttpWork | SlackWork): work is Progress =>
    work.kind === 'continue' || work.kind === 'wait' || work.kind === 'done';
  const agentRequestId = (runId: string, stepId: string) => {
    const hash = createHash('sha256').update(`${runId}:${stepId}`).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  };
  async function advanceTransaction(
    value: unknown,
    completed?: { job: SnippetJob; result: SnippetResult },
    agent?: {
      work: AgentWork;
      taskId?: string | undefined;
      result?: Awaited<ReturnType<AgentTaskClient['result']>> | undefined;
      failed?: boolean;
    },
    http?: { work: HttpWork; result?: Awaited<ReturnType<typeof requestHttp>>; error?: string },
    slack?: { work: SlackWork; result: Awaited<ReturnType<SlackClient['workflow']>> },
  ): Promise<Progress | CodeWork | AgentWork | HttpWork | SlackWork> {
    const work = workSchema.parse(value);
    return transaction(work.workspaceId, async tx => {
      const raw = (
        await tx.client.query(
          `SELECT r.*,m.user_id,d.definition,w.enabled,w.sponsor_membership_id,w.sponsorship_id AS current_sponsorship_id FROM ${table(tx, 'tf_workflow_runs')} r JOIN ${table(tx, 'tf_memberships')} m ON m.id=r.membership_id JOIN ${table(tx, 'tf_workflow_revisions')} d ON d.workflow_id=r.workflow_id AND d.id=r.revision JOIN ${table(tx, 'tf_workflows')} w ON w.id=r.workflow_id WHERE r.id=$1 FOR UPDATE OF r`,
          [work.runId],
        )
      ).rows[0];
      if (!raw || !['queued', 'running', 'waiting'].includes(raw.status)) return { kind: 'done' };
      const allowed =
        raw.enabled &&
        raw.membership_id &&
        (await hasGrant(tx, raw.membership_id, raw.workflow_id, 'invoke')) &&
        (raw.sponsorship_id
          ? raw.sponsorship_id === raw.current_sponsorship_id && raw.membership_id === raw.sponsor_membership_id
          : /^(manual|event):/.test(raw.request_key));
      if (!allowed) {
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_workflow_runs')} SET status='blocked',error='authority-revoked' WHERE id=$1`,
          [work.runId],
        );
        return { kind: 'done' };
      }
      const definition = definitionSchema.parse(raw.definition);
      try {
        await authorizeSource(tx, definition.trigger, idSchema.parse(raw.membership_id));
      } catch {
        await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='blocked',error=$2 WHERE id=$1`, [
          work.runId,
          `${definition.trigger.kind}-authority-revoked`,
        ]);
        return { kind: 'done' };
      }
      try {
        await requireTableStepReader(tx, idSchema.parse(raw.membership_id), definition);
      } catch {
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_workflow_runs')} SET status='blocked',error='table-authority-revoked' WHERE id=$1`,
          [work.runId],
        );
        return { kind: 'done' };
      }
      try {
        await requireAgentStepReader(tx, idSchema.parse(raw.membership_id), definition);
      } catch {
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_workflow_runs')} SET status='blocked',error='agent-authority-revoked' WHERE id=$1`,
          [work.runId],
        );
        return { kind: 'done' };
      }
      try {
        for (const step of definition.steps)
          if (step.kind === 'http' && step.credential)
            await providers.authorizeIntegration(tx, step.credential.integrationId, idSchema.parse(raw.membership_id));
      } catch {
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_workflow_runs')} SET status='blocked',error='http-credential-authority-revoked' WHERE id=$1`,
          [work.runId],
        );
        return { kind: 'done' };
      }
      const rows = (
        await tx.client.query(
          `SELECT step_id,status,output,EXTRACT(EPOCH FROM (due_at-clock_timestamp()))::float8 AS remaining FROM ${table(tx, 'tf_workflow_steps')} WHERE run_id=$1 ORDER BY ordinal`,
          [work.runId],
        )
      ).rows;
      const outputs = new Map<string, z.infer<typeof payloadSchema>>();
      for (const row of rows)
        if (row.status === 'completed') outputs.set(z.string().parse(row.step_id), payloadSchema.parse(row.output));
      const next = nextStep(definition.steps, outputs);
      if (!next) {
        await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='completed' WHERE id=$1`, [
          work.runId,
        ]);
        return { kind: 'done' };
      }
      // A step skipped by a condition leaves no receipt, so a receipt's ordinal is its definition position, not a count.
      const { step, index: ordinal } = next;
      const receipt = rows.find(row => row.step_id === step.id);
      if (step.kind === 'slack-message') {
        const fail = async (error: string): Promise<Progress> => {
          await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='failed',error=$2 WHERE id=$1`, [
            work.runId,
            error,
          ]);
          return { kind: 'done' };
        };
        if (tx.commonVersion < 1 || !options.slackActions) return fail('slack-action-unavailable');
        try {
          z.string()
            .min(1)
            .max(4000)
            .parse(resolveValue(step.text, payloadSchema.parse(raw.input), outputs));
        } catch {
          return fail('slack-message-text-invalid');
        }
        const actionId = agentRequestId(work.runId, step.id);
        if (!receipt) {
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_workflow_steps')} (run_id,step_id,ordinal,status,output,due_at) VALUES ($1,$2,$3,'waiting',$4,clock_timestamp()+interval '24 hours')`,
            [work.runId, step.id, ordinal, JSON.stringify({ provider: 'slack', actionId, status: 'preparing' })],
          );
          await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='waiting' WHERE id=$1`, [
            work.runId,
          ]);
        }
        if (slack?.work.actionId === actionId) {
          const result = slack.result;
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_workflow_steps')} SET output=$3,due_at=$4 WHERE run_id=$1 AND step_id=$2`,
            [
              work.runId,
              step.id,
              JSON.stringify({
                provider: 'slack',
                actionId,
                status: result.status,
                sentMessageTs: result.sentMessageTs ?? null,
              }),
              result.expiresAt,
            ],
          );
          if (result.status === 'sent') {
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_workflow_steps')} SET status='completed' WHERE run_id=$1 AND step_id=$2`,
              [work.runId, step.id],
            );
            await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='running' WHERE id=$1`, [
              work.runId,
            ]);
            return { kind: 'continue' };
          }
          if (
            ['rejected', 'expired', 'stale', 'revoked', 'unknown', 'reauthorization-required'].includes(result.status)
          )
            return fail(`slack-action-${result.status}`);
          const due = result.status === 'pending' ? result.expiresAt : result.nextAttemptAt;
          return {
            kind: 'wait',
            seconds: Math.max(
              1,
              Math.ceil((Math.min(Date.parse(due), Date.parse(result.expiresAt)) - Date.now()) / 1000),
            ),
          };
        }
        return { kind: 'slack', workspaceId: work.workspaceId, runId: work.runId, stepId: step.id, actionId };
      }
      if (step.kind === 'condition') {
        let output;
        try {
          output = runCondition(step, payloadSchema.parse(raw.input), outputs);
        } catch (error) {
          if (!(error instanceof ConditionIncomparable)) throw error;
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_workflow_runs')} SET status='failed',error='condition-values-incomparable' WHERE id=$1`,
            [work.runId],
          );
          return { kind: 'done' };
        }
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_workflow_steps')} (run_id,step_id,ordinal,status,output) VALUES ($1,$2,$3,'completed',$4)`,
          [work.runId, step.id, ordinal, JSON.stringify(output)],
        );
        await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='running' WHERE id=$1`, [work.runId]);
        return { kind: 'continue' };
      }
      if (step.kind === 'code') {
        const fail = async (error: string): Promise<Progress> => {
          await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='failed',error=$2 WHERE id=$1`, [
            work.runId,
            error,
          ]);
          return { kind: 'done' };
        };
        if (!options.snippets) return fail('snippet-runner-unavailable');
        let input;
        try {
          input = resolveValue(step.input, payloadSchema.parse(raw.input), outputs);
        } catch {
          return fail('snippet-input-invalid');
        }
        const job: SnippetJob = {
          workspaceId: work.workspaceId,
          runId: work.runId,
          revision: idSchema.parse(raw.revision),
          stepId: step.id,
          language: step.language,
          source: step.source,
          input,
        };
        if (!jobSchema.safeParse(job).success) return fail('snippet-input-invalid');
        if (!receipt) {
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_workflow_steps')} (run_id,step_id,ordinal,status,due_at) VALUES ($1,$2,$3,'waiting',clock_timestamp()+interval '5 minutes')`,
            [work.runId, step.id, ordinal],
          );
          await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='waiting' WHERE id=$1`, [
            work.runId,
          ]);
        } else if (z.number().parse(receipt.remaining) <= 0) return fail('snippet-runner-deadline');
        if (completed && canonical(completed.job) === canonical(job)) {
          if (completed.result.kind === 'failed') return fail(`snippet-${completed.result.error}`);
          if (completed.result.kind === 'completed') {
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_workflow_steps')} SET status='completed',output=$3 WHERE run_id=$1 AND step_id=$2`,
              [work.runId, step.id, JSON.stringify(completed.result.output)],
            );
            await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='running' WHERE id=$1`, [
              work.runId,
            ]);
            return { kind: 'continue' };
          }
          return { kind: 'wait', seconds: 2 };
        }
        return { kind: 'code', job };
      }
      if (step.kind === 'agent') {
        const fail = async (error: string): Promise<Progress> => {
          await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='failed',error=$2 WHERE id=$1`, [
            work.runId,
            error,
          ]);
          return { kind: 'done' };
        };
        if (!options.agentTasks) return fail('agent-task-runner-unavailable');
        let text: string;
        try {
          text = z
            .string()
            .trim()
            .min(1)
            .max(8000)
            .parse(resolveValue(step.prompt, payloadSchema.parse(raw.input), outputs));
        } catch {
          return fail('agent-prompt-invalid');
        }
        const storedTask =
          receipt?.output === null || receipt?.output === undefined
            ? undefined
            : z.object({ taskId: idSchema }).safeParse(receipt.output);
        const taskId = storedTask?.success ? storedTask.data.taskId : undefined;
        const task: AgentWork = {
          kind: 'agent',
          workspaceId: work.workspaceId,
          userId: z.string().parse(raw.user_id),
          taskId,
          request: taskId
            ? undefined
            : { requestId: agentRequestId(work.runId, step.id), agentId: step.agentId, text, limits: step.limits },
        };
        if (!receipt) {
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_workflow_steps')} (run_id,step_id,ordinal,status) VALUES ($1,$2,$3,'waiting')`,
            [work.runId, step.id, ordinal],
          );
          await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='waiting' WHERE id=$1`, [
            work.runId,
          ]);
        }
        if (agent && agent.work.request?.requestId === task.request?.requestId && agent.failed)
          return fail('agent-task-unavailable');
        if (agent && agent.work.taskId === task.taskId && agent.failed) return fail('agent-task-unavailable');
        if (agent && agent.work.request?.requestId === task.request?.requestId && agent.taskId) {
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_workflow_steps')} SET output=$3 WHERE run_id=$1 AND step_id=$2`,
            [work.runId, step.id, JSON.stringify({ taskId: agent.taskId })],
          );
          return { kind: 'wait', seconds: 2 };
        }
        if (agent && agent.work.taskId === task.taskId && agent.result) {
          if (agent.result.status === 'completed') {
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_workflow_steps')} SET status='completed',output=$3 WHERE run_id=$1 AND step_id=$2`,
              [work.runId, step.id, JSON.stringify({ taskId, result: agent.result.text ?? '' })],
            );
            await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='running' WHERE id=$1`, [
              work.runId,
            ]);
            return { kind: 'continue' };
          }
          const output = { taskId, status: agent.result.status, pauseReason: agent.result.pauseReason ?? null };
          if (canonical(receipt?.output ?? null) !== canonical(output)) {
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_workflow_steps')} SET output=$3 WHERE run_id=$1 AND step_id=$2`,
              [work.runId, step.id, JSON.stringify(output)],
            );
          }
          if (agent.result.status === 'failed') return fail('agent-task-failed');
          return { kind: 'wait', seconds: 2 };
        }
        return task;
      }
      if (step.kind === 'http') {
        const fail = async (error: string): Promise<Progress> => {
          await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='failed',error=$2 WHERE id=$1`, [
            work.runId,
            error,
          ]);
          return { kind: 'done' };
        };
        let headers: Record<string, string>, body: string | undefined;
        try {
          headers = Object.fromEntries(
            Object.entries(step.headers).map(([name, source]) => [
              name,
              z
                .string()
                .max(8192)
                .parse(resolveValue(source, payloadSchema.parse(raw.input), outputs)),
            ]),
          );
          body = step.body
            ? JSON.stringify(resolveValue(step.body, payloadSchema.parse(raw.input), outputs))
            : undefined;
          if (body && !headers['content-type']) headers['content-type'] = 'application/json';
          if (step.credential)
            headers[step.credential.header] = await providers.credential(
              work.workspaceId,
              tx,
              step.credential.integrationId,
              idSchema.parse(raw.membership_id),
            );
        } catch {
          return fail('http-request-invalid');
        }
        const request: HttpWork = {
          kind: 'http',
          method: step.method,
          url: step.url,
          headers: { ...headers, 'idempotency-key': `${work.runId}:${step.id}` },
          body,
        };
        if (!receipt) {
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_workflow_steps')} (run_id,step_id,ordinal,status) VALUES ($1,$2,$3,'waiting')`,
            [work.runId, step.id, ordinal],
          );
          await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='waiting' WHERE id=$1`, [
            work.runId,
          ]);
        }
        if (http?.work.url === request.url && http.error) return fail(`http-${http.error}`);
        if (http?.work.url === request.url && http.result) {
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_workflow_steps')} SET status='completed',output=$3 WHERE run_id=$1 AND step_id=$2`,
            [work.runId, step.id, JSON.stringify(http.result)],
          );
          await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='running' WHERE id=$1`, [
            work.runId,
          ]);
          return { kind: 'continue' };
        }
        return request;
      }
      if (isTableStep(step)) {
        const result = await runTableStep(
          { ...tx, workspaceId: work.workspaceId },
          step,
          idSchema.parse(raw.membership_id),
          payloadSchema.parse(raw.input),
          outputs,
        );
        if (result.kind !== 'completed') {
          await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status=$2,error=$3 WHERE id=$1`, [
            work.runId,
            result.kind,
            result.error,
          ]);
          return { kind: 'done' };
        }
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_workflow_steps')} (run_id,step_id,ordinal,status,output) VALUES ($1,$2,$3,'completed',$4)`,
          [work.runId, step.id, ordinal, JSON.stringify(result.output)],
        );
        await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='running' WHERE id=$1`, [work.runId]);
        return { kind: 'continue' };
      }
      if (step.kind === 'transform') {
        let output;
        try {
          output = transform(step, payloadSchema.parse(raw.input), outputs);
        } catch {
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_workflow_runs')} SET status='failed',error='transform-input-invalid' WHERE id=$1`,
            [work.runId],
          );
          return { kind: 'done' };
        }
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_workflow_steps')} (run_id,step_id,ordinal,status,output) VALUES ($1,$2,$3,'completed',$4)`,
          [work.runId, step.id, ordinal, JSON.stringify(output)],
        );
        await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='running' WHERE id=$1`, [work.runId]);
        return { kind: 'continue' };
      }
      let remaining = receipt ? z.number().parse(receipt.remaining) : null;
      if (remaining === null) {
        let due: Date | null = null;
        if (step.kind === 'wait-until') {
          try {
            due = waitUntilInstant(resolveValue(step.at, payloadSchema.parse(raw.input), outputs));
          } catch {
            await tx.client.query(
              `UPDATE ${table(tx, 'tf_workflow_runs')} SET status='failed',error='wait-until-invalid' WHERE id=$1`,
              [work.runId],
            );
            return { kind: 'done' };
          }
        }
        if (due && due.getTime() - (await databaseNow(tx)).getTime() > maxWaitSeconds * 1000) {
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_workflow_runs')} SET status='failed',error='wait-until-too-far' WHERE id=$1`,
            [work.runId],
          );
          return { kind: 'done' };
        }
        const seconds = step.kind === 'delay' ? step.seconds : step.kind === 'human' ? step.timeoutSeconds : null;
        const inserted = (
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_workflow_steps')} (run_id,step_id,ordinal,status,prompt,due_at) VALUES ($1,$2,$3,'waiting',$4,COALESCE($6::timestamptz,clock_timestamp()+$5*interval '1 second')) RETURNING EXTRACT(EPOCH FROM (due_at-clock_timestamp()))::float8 AS remaining`,
            [work.runId, step.id, ordinal, step.kind === 'human' ? step.prompt : null, seconds, due],
          )
        ).rows[0];
        remaining = z.number().parse(inserted.remaining);
        await tx.client.query(`UPDATE ${table(tx, 'tf_workflow_runs')} SET status='waiting' WHERE id=$1`, [work.runId]);
      }
      if (remaining > 0) return { kind: 'wait', seconds: Math.max(1, Math.ceil(remaining)) };
      if (step.kind === 'human') {
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_workflow_runs')} SET status='failed',error='human-input-expired' WHERE id=$1`,
          [work.runId],
        );
        return { kind: 'done' };
      }
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_workflow_steps')} SET status='completed',output='null'::jsonb WHERE run_id=$1 AND step_id=$2`,
        [work.runId, step.id],
      );
      return { kind: 'continue' };
    });
  }
  async function advance(value: unknown): Promise<Progress> {
    const progress = await advanceTransaction(value);
    if (progress.kind === 'slack') {
      const result = await options.slackActions!.workflow(
        progress.workspaceId,
        progress.runId,
        progress.stepId,
        progress.actionId,
      );
      const next = await advanceTransaction(value, undefined, undefined, undefined, { work: progress, result });
      return isProgress(next) ? next : { kind: 'wait', seconds: 5 };
    }
    if (progress.kind === 'agent') {
      try {
        if (progress.request) {
          const task = await options.agentTasks?.start(progress.workspaceId, progress.userId, progress.request);
          const next = await advanceTransaction(value, undefined, { work: progress, taskId: task?.id });
          return isProgress(next) ? next : { kind: 'wait', seconds: 2 };
        }
        const result = await options.agentTasks?.result(progress.workspaceId, progress.userId, progress.taskId!);
        const next = await advanceTransaction(value, undefined, { work: progress, result });
        return isProgress(next) ? next : { kind: 'wait', seconds: 2 };
      } catch {
        try {
          const next = await advanceTransaction(value, undefined, { work: progress, failed: true });
          return isProgress(next) ? next : { kind: 'wait', seconds: 5 };
        } catch {
          return { kind: 'wait', seconds: 5 };
        }
      }
    }
    if (progress.kind === 'http') {
      try {
        const result = await requestHttp(progress);
        const next = await advanceTransaction(value, undefined, undefined, { work: progress, result });
        return isProgress(next) ? next : { kind: 'continue' };
      } catch (error) {
        if (error instanceof HttpStepError) {
          const next = await advanceTransaction(value, undefined, undefined, { work: progress, error: error.code });
          return isProgress(next) ? next : { kind: 'continue' };
        }
        throw error;
      }
    }
    if (progress.kind !== 'code') return progress;
    let result: SnippetResult;
    try {
      result = resultSchema.parse(await options.snippets?.submit(progress.job));
    } catch {
      return { kind: 'wait', seconds: 5 };
    }
    const next = await advanceTransaction(value, { job: progress.job, result });
    return isProgress(next) ? next : { kind: 'continue' };
  }
  async function activity(value: unknown): Promise<Progress> {
    try {
      return await advance(value);
    } catch {
      throw new Error('workflow-storage-unavailable');
    }
  }
  const candidates = (workspaceId: string, user: string) => transaction(workspaceId, tx => sharingCandidates(tx, user));
  const grants = (workspaceId: string, user: string, id: string) =>
    transaction(workspaceId, tx => listGrants(tx, user, id, 'workflow'));
  const share = (workspaceId: string, user: string, id: string, value: unknown) =>
    wakeAfter(workspaceId, async (tx, woken) => {
      const result = await changeGrant(tx, user, id, value, 'workflow');
      await liveRuns(tx, id, woken);
      return result;
    });
  return {
    list,
    definition,
    runDetail,
    calendar,
    followCalendar,
    recent,
    recordSourceLabels,
    rowSourceLabels,
    checkTableSteps,
    save,
    activate,
    archive,
    cancelRowEvents,
    start,
    history,
    respond,
    cancel,
    webhookKey,
    revokePreviousWebhookKey,
    webhook,
    testWebhook,
    recordWebhookDelivery,
    webhookDeliveries,
    event,
    due,
    resumable,
    advance,
    activity,
    providers,
    candidates,
    grants,
    share,
    sponsorship,
    acceptSponsorship,
    slackOrigin,
    slackSender,
    slackSources,
  };
}
