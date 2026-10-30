import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  canAccessAsset,
  currentMember,
  lockAuthorization,
  requireCurrentActor,
  requireTeamMember,
  resolveHuman,
  sourceDependenciesSchema,
  type HumanActor,
} from '@tulipfarm/access';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import {
  createChannelProvider,
  SlackApiError,
  slackActionSchema,
  slackActionViewSchema,
  slackDecisionSchema,
  slackActionCard,
  openBotDirectMessage,
  postBotMessage,
  slackSenderSchema,
  type SlackAction,
  type SlackSender,
} from '@tulipfarm/slack';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { requireDraftSources } from './draft-sources.ts';
import { requireNoMcpDerived } from '@tulipfarm/access';
import { requireAgentPermission } from './saved-policy.ts';
import { resultSources } from './tool-sources.ts';
import { toolCallSchema, toolResultSchema } from './contracts.ts';
import { taskRun } from './task-approval-gate.ts';
import { requireCurrentConversationSources } from '@tulipfarm/conversations/source-access';
import { turnRequester } from '@tulipfarm/conversations/turn-requester';
import { canAccessSlackInstallation, SlackChannelAccessError, slackResolveSchema } from '@tulipfarm/slack';
import { commonCompatibility, StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '@tulipfarm/workflows';
import { errorType, isFeatureEnabled, log } from '@tulipfarm/observability';
import { claimRunImages, deliverRunImages, type DeliveredMessage, type SlackImageFiles } from './slack-images.ts';

type Transaction = AgentTransaction & { commonVersion: number };
type Options = Parameters<typeof createChannelProvider>[0] & {
  runtime: AgentStorage;
  audienceSources?: (tx: AgentTransaction, workspaceId: string, actor: HumanActor, runId: string) => Promise<void>;
  appSenderEnabled?: (workspaceId: string, userId: string) => Promise<boolean>;
  /** Reads the images a run generated, so a delivered message can carry them as Slack files. */
  images?: SlackImageFiles;
};
export type SlackActionsFactory = (runtime: AgentStorage) => ReturnType<typeof createSlackActions>;
const range = commonCompatibility;
const hasSender = (tx: AgentTransaction) => 'commonVersion' in tx && Number(tx.commonVersion) >= 1;
const rowSchema = z.object({
  id: z.uuid(),
  run_id: z.uuid(),
  user_id: z.string(),
  membership_id: z.uuid(),
  identity_id: z.uuid(),
  destination_id: z.uuid(),
  destination_version: z.number(),
  agent_policy_version: z.number(),
  installation_id: z.uuid(),
  generation: z.number(),
  channel: z.string(),
  action: slackActionSchema,
  digest: z.string(),
  approval_required: z.boolean(),
  expires_at: z.date(),
  state: z.string(),
  next_attempt_at: z.date(),
  decision: z.enum(['approve', 'reject']).nullable(),
});
type Row = z.infer<typeof rowSchema> & {
  provider_digest: string;
  sent_message_ts?: string | null;
  notification_state?: string | null;
  sender?: SlackSender;
};
const destinationSchema = z.object({
  id: z.uuid(),
  installation_id: z.uuid(),
  generation: z.number(),
  channel: z.string(),
  version: z.number(),
  enabled: z.boolean(),
});
const source = (row: Pick<Row, 'installation_id' | 'generation' | 'channel'>, action: SlackAction) => ({
  installationId: row.installation_id,
  generation: row.generation,
  channel: row.channel,
  rootTs:
    action.tool === 'slack.thread.reply'
      ? action.threadTs
      : action.tool === 'slack.reaction.add'
        ? action.messageTs
        : '0.000000',
});
const view = (row: Row) =>
  slackActionViewSchema.parse({
    provider: 'slack',
    id: row.id,
    runId: row.run_id,
    digest: row.digest,
    action: row.action,
    channel: row.channel,
    status:
      row.state !== 'pending'
        ? row.state
        : row.decision === 'reject'
          ? 'rejected'
          : row.expires_at.getTime() <= Date.now()
            ? 'expired'
            : row.decision === 'approve' || !row.approval_required
              ? 'approved'
              : 'pending',
    approvalRequired: row.approval_required,
    expiresAt: row.expires_at.toISOString(),
    nextAttemptAt: row.next_attempt_at.toISOString(),
    sentMessageTs: row.sent_message_ts ?? null,
    notificationStatus: row.notification_state ?? null,
    sender: row.sender ?? 'user',
  });

export function createSlackActions(options: Options) {
  const provider = createChannelProvider(options);
  const workflows = createWorkflows(options.runtime);
  const providerDigest = createHash('sha256')
    .update(canonicalJson({ provider: 'slack-web-api', version: 1 }))
    .digest('hex');
  async function transaction<T>(workspaceId: string, operation: (tx: Transaction) => Promise<T>) {
    return options.runtime.transaction(workspaceId, range, async tx => {
      await lockAuthorization(tx);
      return operation(tx);
    });
  }
  async function load(tx: AgentTransaction, id: string) {
    const row = rowSchema
      .extend({
        provider_digest: z.string(),
        sent_message_ts: z.string().nullable(),
        notification_state: z.string().nullable(),
        sender: slackSenderSchema.default('user'),
      })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT a.*,e.state,e.next_attempt_at,${'commonVersion' in tx && Number(tx.commonVersion) >= 1 ? 'e.sent_message_ts' : 'NULL AS sent_message_ts'},d.decision,CASE WHEN c.state='sending' AND c.next_attempt_at<=clock_timestamp() THEN 'unknown' ELSE c.state END AS notification_state FROM ${relation(tx, 'tf_slack_actions')} a JOIN ${relation(tx, 'tf_slack_action_effects')} e ON e.action_id=a.id LEFT JOIN ${relation(tx, 'tf_slack_action_decisions')} d ON d.action_id=a.id LEFT JOIN ${relation(tx, 'tf_slack_action_cards')} c ON c.action_id=a.id WHERE a.id=$1`,
            [z.uuid().parse(id)],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    return row;
  }
  async function loadDestination(tx: AgentTransaction, actor: HumanActor, id: string) {
    const row = destinationSchema
      .optional()
      .parse(
        (await tx.client.query(`SELECT * FROM ${relation(tx, 'tf_slack_destinations')} WHERE id=$1 AND enabled`, [id]))
          .rows[0],
      );
    if (!row) throw new AccessDenied();
    await currentMember(tx, actor);
    return row;
  }
  async function owner(tx: AgentTransaction, runId: string, callId: string, action: SlackAction) {
    const workflow = await workflowOrigin(tx, runId, callId);
    if (workflow) {
      const origin = await workflows.slackOrigin(tx as Transaction, runId, workflow.step_id);
      if (
        canonicalJson(origin.action) !== canonicalJson(action) ||
        canonicalJson(workflow.action) !== canonicalJson(action) ||
        origin.revision !== workflow.revision ||
        origin.workflowId !== workflow.workflow_id
      )
        throw new AccessDenied();
      await currentMember(tx, origin.actor);
      await loadDestination(tx, origin.actor, action.destinationId);
      return origin.actor;
    }
    const conversation = await conversationOrigin(tx, runId, callId);
    if (conversation) {
      await requireNoMcpDerived(tx, conversation.sources);
      await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_conversations')} WHERE id=$1 FOR UPDATE`, [
        conversation.conversation_id,
      ]);
      if (canonicalJson(conversation.action) !== canonicalJson(action)) throw new AccessDenied();
      const actor = await turnRequester(tx, conversation.conversation_id, runId);
      await currentMember(tx, actor);
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${relation(tx, 'tf_conversation_turns')} WHERE id=$1 AND status IN ('processing','waiting','completed')`,
            [runId],
          )
        ).rowCount
      )
        throw new AccessDenied();
      await loadDestination(tx, actor, action.destinationId);
      await requireCurrentConversationSources(tx, conversation.conversation_id, runId);
      return actor;
    }
    await requireCurrentActor(tx, { kind: 'agent', runId });
    const task = await taskRun(tx, runId);
    if (task && task.generation !== task.current_generation) throw new AccessDenied();
    if (
      task &&
      !(
        await tx.client.query(
          `SELECT 1 FROM ${relation(tx, 'tf_agent_tasks')} WHERE id=$1 AND status IN ('pending','waiting-approval')`,
          [task.task_id],
        )
      ).rowCount
    )
      throw new AccessDenied();
    const row = z
      .object({ user_id: z.string(), membership_id: z.uuid() })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT r.user_id,r.membership_id FROM ${relation(tx, 'tf_agent_runs')} r JOIN ${relation(tx, 'tf_agent_tool_calls')} c ON c.run_id=r.id JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id=r.agent_id AND d.revision=r.definition_revision WHERE r.id=$1 AND r.kind='delegated' AND c.id=$2 AND c.call=$3::jsonb AND d.definition->'tools' ? $4 AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_agent_tool_calls')} p WHERE p.run_id=r.id AND p.sequence<c.sequence AND p.status<>'completed')`,
            [runId, callId, JSON.stringify(action), action.tool],
          )
        ).rows[0],
      );
    if (!row) throw new AccessDenied();
    const actor: HumanActor = { kind: 'human', userId: row.user_id, membershipId: row.membership_id };
    await currentMember(tx, actor);
    await loadDestination(tx, actor, action.destinationId);
    if (!(await canAccessAsset(tx, { kind: 'agent', runId }, action.destinationId, action.tool)))
      throw new AccessDenied();
    return actor;
  }
  async function sources(tx: AgentTransaction, workspaceId: string, actor: HumanActor, runId: string, callId: string) {
    const workflow = await workflowOrigin(tx, runId, callId);
    if (workflow) {
      const { authoredText } = await workflows.slackSources(
        tx as Transaction,
        runId,
        workflow.step_id,
        actor.membershipId,
      );
      const drafts = await tx.client.query(
        `SELECT d.sources,d.conversation_id,d.turn_id FROM ${relation(tx, 'tf_chat_authoring_drafts')} d JOIN ${relation(tx, 'tf_chat_authoring_decisions')} c ON c.draft_id=d.id WHERE c.outcome->>'kind'='workflow' AND c.outcome->>'workflowId'=$1 AND c.outcome->>'revision'=$2`,
        [workflow.workflow_id, workflow.revision],
      );
      for (const draft of drafts.rows) {
        let dependencies = sourceDependenciesSchema.parse(draft.sources);
        await requireNoMcpDerived(tx, dependencies);
        if (authoredText) {
          const prior = (
            await tx.client.query(
              `SELECT 1 FROM ${relation(tx, 'tf_conversation_turns')} WHERE conversation_id=$1 AND accepted_sequence<(SELECT accepted_sequence FROM ${relation(tx, 'tf_conversation_turns')} WHERE id=$2)`,
              [draft.conversation_id, draft.turn_id],
            )
          ).rowCount;
          if (!prior)
            dependencies = dependencies.filter(
              source => source.kind !== 'private-conversation' || source.conversationId !== draft.conversation_id,
            );
          await requireDraftSources(tx, actor, dependencies, new Set(), undefined, true);
        }
      }
      return;
    }
    const conversation = await conversationOrigin(tx, runId);
    if (conversation) {
      await requireCurrentConversationSources(tx, conversation.conversation_id, runId);
      for (const dependency of conversation.sources) {
        if (dependency.kind === 'shared-slack-turn') {
          if (!options.audienceSources) throw new AccessDenied();
          await options.audienceSources(tx, workspaceId, actor, dependency.eventId);
        } else await requireDraftSources(tx, actor, [dependency], new Set(), undefined, true);
      }
      const attachments = await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_conversation_parts')} p JOIN ${relation(tx, 'tf_conversation_turns')} t ON t.source_message_id=p.message_id WHERE t.id=$1 AND p.kind='attachment'`,
        [runId],
      );
      if (attachments.rowCount) throw new AccessDenied();
      return;
    }
    const task = await taskRun(tx, runId);
    if (task) {
      const messages = await tx.client.query(
        `SELECT sources FROM ${relation(tx, 'tf_agent_task_messages')} WHERE task_id=$1`,
        [task.task_id],
      );
      for (const message of messages.rows) {
        const sources = z.array(z.object({ kind: z.string(), tableId: z.uuid().optional() })).parse(message.sources);
        for (const source of sources) {
          if (
            source.kind !== 'table' ||
            !source.tableId ||
            !(await canAccessAsset(tx, actor, source.tableId, 'table.row.read'))
          )
            throw new AccessDenied();
        }
      }
    }
    const external = (
      await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_slack_agent_turns')} WHERE run_id=$1`, [runId])
    ).rowCount;
    if (external) {
      if (!options.audienceSources) throw new AccessDenied();
      await options.audienceSources(tx, workspaceId, actor, runId);
      return;
    }
    const definition = z
      .object({
        agent_id: z.uuid(),
        definition: z.object({ skills: z.array(z.object({ id: z.string(), revision: z.string() })).optional() }),
      })
      .parse(
        (
          await tx.client.query(
            `SELECT r.agent_id,d.definition FROM ${relation(tx, 'tf_agent_runs')} r JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id=r.agent_id AND d.revision=r.definition_revision WHERE r.id=$1`,
            [runId],
          )
        ).rows[0],
      );
    await requireAgentPermission(tx, actor, definition.agent_id, 'read');
    for (const skill of definition.definition.skills ?? [])
      if (z.uuid().safeParse(skill.id).success)
        await requireDraftSources(
          tx,
          actor,
          [{ kind: 'workspace-skill', skillId: skill.id, revision: skill.revision }],
          new Set(),
          undefined,
          true,
        );
    const derived = await tx.client.query(
      `SELECT d.sources FROM ${relation(tx, 'tf_chat_authoring_drafts')} d JOIN ${relation(tx, 'tf_chat_authoring_decisions')} c ON c.draft_id=d.id JOIN ${relation(tx, 'tf_agent_commands')} a ON a.id::text=c.outcome->'receipt'->>'commandId' JOIN ${relation(tx, 'tf_agent_saved_revisions')} s ON s.agent_id=a.agent_id AND s.soul_revision=a.accepted_revision JOIN ${relation(tx, 'tf_agent_runs')} r ON r.agent_id=s.agent_id AND r.definition_revision=s.definition_revision WHERE r.id=$1`,
      [runId],
    );
    for (const row of derived.rows)
      await requireDraftSources(tx, actor, sourceDependenciesSchema.parse(row.sources), new Set(), undefined, true);
    const calls = z
      .array(z.object({ call: toolCallSchema, result: toolResultSchema }))
      .parse(
        (
          await tx.client.query(
            `SELECT call,result FROM ${relation(tx, 'tf_agent_tool_calls')} WHERE run_id=$1 AND status='completed'`,
            [runId],
          )
        ).rows,
      );
    for (const row of calls) {
      if (row.call.tool.startsWith('slack.')) continue;
      if (row.call.tool === 'github.issue.read' || row.call.tool.startsWith('google.')) throw new AccessDenied();
      if ('tableId' in row.call && !(await canAccessAsset(tx, actor, row.call.tableId, 'table.row.read')))
        throw new AccessDenied();
      await requireDraftSources(tx, actor, await resultSources(tx, row.call, row.result), new Set(), undefined, true);
    }
  }
  async function fresh(tx: AgentTransaction, workspaceId: string, row: Row) {
    if (row.provider_digest !== providerDigest) throw new Error('slack-action-stale');
    const actor = await owner(tx, row.run_id, row.id, row.action);
    if (actor.userId !== row.user_id || actor.membershipId !== row.membership_id) throw new AccessDenied();
    const destination = destinationSchema
      .optional()
      .parse(
        (
          await tx.client.query(`SELECT * FROM ${relation(tx, 'tf_slack_destinations')} WHERE id=$1`, [
            row.destination_id,
          ])
        ).rows[0],
      );
    const policy = await agentPolicy(tx, row.run_id, row.id);
    if ((row.sender ?? 'user') === 'app' && policy.sender !== 'app') throw new Error('slack-action-stale');
    if (
      !destination?.enabled ||
      destination.version !== row.destination_version ||
      destination.channel !== row.channel ||
      destination.installation_id !== row.installation_id ||
      destination.generation !== row.generation ||
      policy.version !== row.agent_policy_version
    )
      throw new Error('slack-action-stale');
    const identity = await provider.identity(tx, actor, source(row, row.action));
    if (identity.id !== row.identity_id) throw new AccessDenied();
    const observed = await provider.observe(
      tx,
      workspaceId,
      actor,
      source(row, row.action),
      row.action.tool !== 'slack.message.send',
    );
    if (!observed.archiveVerified) throw new AccessDenied();
    await sources(tx, workspaceId, actor, row.run_id, row.id);
    const final = await provider.observe(tx, workspaceId, actor, source(row, row.action), false);
    if (canonicalJson(final.members) !== canonicalJson(observed.members)) throw new AccessDenied();
    return { actor, audience: { members: final.members, botUserId: final.botUserId } };
  }
  async function prepare(workspaceId: string, runId: string, callId: string, value: unknown) {
    const action = slackActionSchema.parse(value);
    return transaction(workspaceId, async tx => {
      const origin = await conversationOrigin(tx, runId, callId);
      const workflow = await workflowOrigin(tx, runId, callId);
      await requireNoMcpDerived(tx, origin?.sources ?? [], origin || workflow ? undefined : { kind: 'agent', runId });
      await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,93851))', [`${tx.schema}:${callId}`]);
      if ((await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_slack_actions')} WHERE id=$1`, [callId])).rowCount) {
        const row = await load(tx, callId);
        if (row.run_id !== runId || canonicalJson(row.action) !== canonicalJson(action)) throw new AccessDenied();
        if (workflow && !row.approval_required && ['pending', 'retry'].includes(row.state))
          throw new StorageUnavailableError('incompatible_version');
        return view(row);
      }
      const actor = await owner(tx, runId, callId, action);
      await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,93852))', [
        `${tx.schema}:${actor.membershipId}`,
      ]);
      const count = z
        .number()
        .parse(
          (
            await tx.client.query(
              `SELECT count(*)::int AS count FROM ${relation(tx, 'tf_slack_actions')} WHERE membership_id=$1 AND created_at>clock_timestamp()-interval '1 hour'`,
              [actor.membershipId],
            )
          ).rows[0]?.count,
        );
      if (count >= 100) throw new AccessDenied();
      const destination = await loadDestination(tx, actor, action.destinationId);
      const identity = await provider.identity(tx, actor, source(destination, action));
      const policy = await agentPolicy(tx, runId, callId),
        policyVersion = policy.version;
      const sender: SlackSender =
        policy.sender === 'app' &&
        hasSender(tx) &&
        (await options.appSenderEnabled?.(workspaceId, actor.userId)) !== false
          ? 'app'
          : 'user';
      const approvalRequired = Boolean(workflow);
      const digest = createHash('sha256')
        .update(
          canonicalJson({
            workspaceId,
            runId,
            callId,
            actor,
            action,
            destination,
            policyVersion,
            providerDigest,
            identityId: identity.id,
            ...(sender === 'app' ? { sender } : {}),
          }),
        )
        .digest('hex');
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_slack_actions')} (id,run_id,user_id,membership_id,identity_id,destination_id,destination_version,installation_id,generation,channel,action,digest,approval_required,agent_policy_version,provider_digest${hasSender(tx) ? ',sender' : ''}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15${hasSender(tx) ? ',$16' : ''})`,
        [
          callId,
          runId,
          actor.userId,
          actor.membershipId,
          identity.id,
          destination.id,
          destination.version,
          destination.installation_id,
          destination.generation,
          destination.channel,
          action,
          digest,
          approvalRequired,
          policyVersion,
          providerDigest,
          ...(hasSender(tx) ? [sender] : []),
        ],
      );
      await tx.client.query(`INSERT INTO ${relation(tx, 'tf_slack_action_effects')} (action_id) VALUES ($1)`, [callId]);
      const row = await load(tx, callId);
      try {
        await fresh(tx, workspaceId, row);
      } catch (error) {
        if (!(error instanceof SlackApiError)) throw error;
        const state =
          error.code === 'rate-limited'
            ? 'retry'
            : error.code === 'provider-auth-rejected'
              ? 'reauthorization-required'
              : 'unknown';
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_slack_action_effects')} SET state=$2,next_attempt_at=clock_timestamp()+$3*interval '1 second' WHERE action_id=$1`,
          [callId, state, error.retryAfterSeconds ?? 60],
        );
      }
      return view(await load(tx, callId));
    });
  }
  async function execute(
    workspaceId: string,
    runId: string,
    callId: string,
    action: SlackAction,
    beforeDispatch?: (tx: Transaction) => Promise<void>,
  ) {
    await prepare(workspaceId, runId, callId, action);
    const attempt = randomUUID();
    const claimed = await transaction(workspaceId, async tx => {
      const origin = await conversationOrigin(tx, runId, callId);
      if (origin)
        await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_conversations')} WHERE id=$1 FOR UPDATE`, [
          origin.conversation_id,
        ]);
      await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_slack_action_effects')} WHERE action_id=$1 FOR UPDATE`, [
        callId,
      ]);
      let row = await load(tx, callId);
      if (row.state === 'sending' && row.next_attempt_at.getTime() <= Date.now()) {
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_slack_action_effects')} SET state='unknown' WHERE action_id=$1`,
          [callId],
        );
        row = await load(tx, callId);
      }
      if (!['pending', 'retry'].includes(row.state)) return { kind: 'view' as const, value: view(row) };
      if (row.decision === 'reject' || row.expires_at.getTime() <= Date.now()) {
        await tx.client.query(`UPDATE ${relation(tx, 'tf_slack_action_effects')} SET state=$2 WHERE action_id=$1`, [
          callId,
          row.decision === 'reject' ? 'rejected' : 'expired',
        ]);
        return { kind: 'view' as const, value: view(await load(tx, callId)) };
      }
      if (row.next_attempt_at.getTime() > Date.now()) return { kind: 'view' as const, value: view(row) };
      try {
        await fresh(tx, workspaceId, row);
      } catch (error) {
        if (error instanceof SlackApiError) {
          const state =
            error.code === 'rate-limited'
              ? 'retry'
              : error.code === 'provider-auth-rejected'
                ? 'reauthorization-required'
                : 'unknown';
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_slack_action_effects')} SET state=$2,next_attempt_at=clock_timestamp()+$3*interval '1 second' WHERE action_id=$1`,
            [callId, state, error.retryAfterSeconds ?? 60],
          );
          return { kind: 'view' as const, value: view(await load(tx, callId)) };
        }
        if (!(error instanceof AccessDenied) && !(error instanceof Error && error.message === 'slack-action-stale'))
          throw error;
        await tx.client.query(`UPDATE ${relation(tx, 'tf_slack_action_effects')} SET state=$2 WHERE action_id=$1`, [
          callId,
          error instanceof AccessDenied ? 'revoked' : 'stale',
        ]);
        return { kind: 'view' as const, value: view(await load(tx, callId)) };
      }
      if (row.approval_required && row.decision !== 'approve') {
        if (row.state === 'retry')
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_slack_action_effects')} SET state='pending' WHERE action_id=$1 AND state='retry'`,
            [callId],
          );
        return { kind: 'view' as const, value: view(await load(tx, callId)) };
      }
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_slack_action_effects')} SET state='sending',attempt_id=$2,next_attempt_at=clock_timestamp()+interval '120 seconds' WHERE action_id=$1`,
        [callId, attempt],
      );
      return { kind: 'claimed' as const };
    });
    if (claimed.kind === 'view') return claimed.value;
    const images = !!options.images && (await isFeatureEnabled('images', null, { id: workspaceId }).catch(() => false));
    let delivered = null as DeliveredMessage | null;
    await transaction(workspaceId, async tx => {
      delivered = null;
      let message = null as DeliveredMessage | null;
      const origin = await conversationOrigin(tx, runId, callId);
      if (origin)
        await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_conversations')} WHERE id=$1 FOR UPDATE`, [
          origin.conversation_id,
        ]);
      await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_slack_action_effects')} WHERE action_id=$1 FOR UPDATE`, [
        callId,
      ]);
      const row = await load(tx, callId);
      if (
        row.state !== 'sending' ||
        !(
          await tx.client.query(
            `SELECT 1 FROM ${relation(tx, 'tf_slack_action_effects')} WHERE action_id=$1 AND attempt_id=$2`,
            [callId, attempt],
          )
        ).rowCount
      )
        return;
      let state = 'unknown',
        seconds = 0,
        sentMessageTs: string | null = null;
      try {
        if ((await workflowOrigin(tx, runId, callId)) && (!row.approval_required || row.decision !== 'approve'))
          throw new Error('slack-action-stale');
        const { actor, audience } = await fresh(tx, workspaceId, row);
        if (row.expires_at.getTime() <= Date.now()) state = 'expired';
        else {
          sentMessageTs =
            (await provider.dispatch(
              tx,
              workspaceId,
              actor,
              source(row, row.action),
              row.action,
              async () => {
                await fresh(tx, workspaceId, row);
                await beforeDispatch?.(tx);
              },
              row.sender ?? 'user',
            )) ?? null;
          state = 'sent';
          const threadTs = row.action.tool === 'slack.thread.reply' ? row.action.threadTs : sentMessageTs;
          if (threadTs && row.action.tool !== 'slack.reaction.add')
            message = {
              workspaceId,
              actionId: row.id,
              runId: row.run_id,
              userId: row.user_id,
              installationId: row.installation_id,
              generation: row.generation,
              channel: row.channel,
              threadTs,
              ...audience,
            };
        }
      } catch (error) {
        if (error instanceof SlackApiError && error.code === 'rate-limited') {
          state = 'retry';
          seconds = error.retryAfterSeconds ?? 60;
        } else if (error instanceof SlackApiError && error.code === 'provider-auth-rejected')
          state = 'reauthorization-required';
        else if (error instanceof AccessDenied) state = 'revoked';
        else if (error instanceof Error && error.message === 'slack-action-stale') state = 'stale';
      }
      if (tx.commonVersion >= 1)
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_slack_action_effects')} SET state=$2,next_attempt_at=clock_timestamp()+$3*interval '1 second',sent_message_ts=$4 WHERE action_id=$1`,
          [callId, state, seconds, sentMessageTs],
        );
      else
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_slack_action_effects')} SET state=$2,next_attempt_at=clock_timestamp()+$3*interval '1 second' WHERE action_id=$1`,
          [callId, state, seconds],
        );
      if (images && message && tx.commonVersion >= 17 && (await claimRunImages(tx, message))) delivered = message;
    });
    // Only the attempt that sent the message shares its images; a retry finds the message sent and stops above.
    if (delivered && options.images)
      await deliverRunImages(delivered, {
        transaction: operation => transaction(workspaceId, operation),
        files: options.images,
        cipher: options.cipher,
        fetcher: options.fetcher,
      });
    return transaction(workspaceId, async tx => view(await load(tx, callId)));
  }
  async function notify(workspaceId: string, callId: string) {
    const updated = await transaction(workspaceId, async tx => {
      const row = await load(tx, callId);
      const card = z
        .object({ channel: z.string(), message_ts: z.string(), presented_status: z.string().nullable() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT channel,message_ts,presented_status FROM ${relation(tx, 'tf_slack_action_cards')} WHERE action_id=$1 AND state='sent' FOR UPDATE`,
              [callId],
            )
          ).rows[0],
        );
      if (!card) return false;
      const value = view(row);
      if (card.presented_status === value.status) return true;
      const actor = await resolveHuman(tx, row.user_id);
      if (actor.membershipId !== row.membership_id) throw new AccessDenied();
      await provider.identity(tx, actor, source(row, row.action));
      await sources(tx, workspaceId, actor, row.run_id, row.id);
      const raw = (
        await tx.client.query(
          `SELECT bot_credential FROM ${relation(tx, 'tf_slack_installations')} WHERE id=$1 AND generation=$2 AND state='active'`,
          [row.installation_id, row.generation],
        )
      ).rows[0];
      if (!raw) throw new AccessDenied();
      const token = options.cipher.decrypt(
        { workspaceId, installationId: row.installation_id, generation: row.generation, kind: 'bot' },
        raw.bot_credential,
      );
      const presentation = slackActionCard(workspaceId, value);
      const result = await postBotMessage({
        token,
        channel: card.channel,
        replaceTs: card.message_ts,
        text: presentation.text,
        presentation,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      });
      if (result.kind === 'sent')
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_slack_action_cards')} SET presented_status=$2 WHERE action_id=$1`,
          [callId, value.status],
        );
      return true;
    });
    if (updated) return;
    const claimed = await transaction(workspaceId, async tx => {
      const row = await load(tx, callId);
      if (view(row).status !== 'pending') return false;
      return Boolean(
        (
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_slack_action_cards')} (action_id,state,next_attempt_at) VALUES ($1,'sending',clock_timestamp()+interval '120 seconds') ON CONFLICT (action_id) DO UPDATE SET state='sending',next_attempt_at=EXCLUDED.next_attempt_at WHERE tf_slack_action_cards.state='retry' AND tf_slack_action_cards.next_attempt_at<=clock_timestamp() RETURNING action_id`,
            [callId],
          )
        ).rowCount,
      );
    });
    if (!claimed) return;
    await transaction(workspaceId, async tx => {
      const row = await load(tx, callId);
      let state = 'unknown',
        seconds = 0,
        channel: string | null = null,
        ts: string | null = null;
      try {
        const { actor } = await fresh(tx, workspaceId, row);
        const identity = await provider.identity(tx, actor, source(row, row.action));
        const raw = (
          await tx.client.query(
            `SELECT bot_credential FROM ${relation(tx, 'tf_slack_installations')} WHERE id=$1 AND generation=$2 AND state='active'`,
            [row.installation_id, row.generation],
          )
        ).rows[0];
        if (!raw) throw new AccessDenied();
        const token = options.cipher.decrypt(
          { workspaceId, installationId: row.installation_id, generation: row.generation, kind: 'bot' },
          raw.bot_credential,
        );
        channel = await openBotDirectMessage(token, identity.slack_user_id, options.fetcher);
        const presentation = slackActionCard(workspaceId, view(row));
        const result = await postBotMessage({
          token,
          channel,
          text: presentation.text,
          presentation,
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        });
        state = result.kind;
        seconds = result.kind === 'retry' ? result.seconds : 0;
        ts = result.kind === 'sent' ? result.ts : null;
      } catch (error) {
        if (error instanceof AccessDenied) state = 'blocked';
      }
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_slack_action_cards')} SET state=$2,next_attempt_at=clock_timestamp()+$3*interval '1 second',channel=$4,message_ts=$5,presented_status='pending' WHERE action_id=$1 AND state='sending'`,
        [callId, state, seconds, channel, ts],
      );
    });
  }
  async function read(workspaceId: string, userId: string, callId: string) {
    return transaction(workspaceId, async tx => {
      const actor = await resolveHuman(tx, userId),
        row = await load(tx, callId);
      if (actor.userId !== row.user_id || actor.membershipId !== row.membership_id) throw new AccessDenied();
      await sources(tx, workspaceId, actor, row.run_id, row.id);
      if (['pending', 'retry'].includes(row.state)) {
        try {
          await fresh(tx, workspaceId, row);
        } catch (error) {
          if (error instanceof AccessDenied) return view({ ...row, state: 'revoked' });
          if (error instanceof SlackApiError && error.code === 'provider-auth-rejected')
            return view({ ...row, state: 'reauthorization-required' });
          if (error instanceof Error && error.message === 'slack-action-stale') return view({ ...row, state: 'stale' });
          throw error;
        }
      }
      return view(row);
    });
  }
  async function decide(
    workspaceId: string,
    userId: string,
    callId: string,
    value: unknown,
    record: (row: Row, decision: 'approve' | 'reject') => Promise<void>,
  ) {
    const input = slackDecisionSchema.parse(value);
    return transaction(workspaceId, async tx => {
      await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,93851))', [`${tx.schema}:${callId}`]);
      const actor = await resolveHuman(tx, userId),
        row = await load(tx, callId);
      if (actor.userId !== row.user_id || actor.membershipId !== row.membership_id) throw new AccessDenied();
      await currentMember(tx, actor);
      const currentIdentity = await provider.identity(tx, actor, source(row, row.action));
      if (currentIdentity.id !== row.identity_id) throw new AccessDenied();
      if (row.digest !== input.digest || (row.decision && row.decision !== input.decision))
        throw new Error('slack-decision-conflict');
      if (row.decision) {
        if ((await workflowOrigin(tx, row.run_id, row.id)) && !['pending', 'retry', 'sending'].includes(row.state))
          return view(row);
        await fresh(tx, workspaceId, row);
        return view(row);
      }
      if (!row.approval_required || row.state !== 'pending' || row.expires_at.getTime() <= Date.now())
        throw new Error('slack-decision-conflict');
      await fresh(tx, workspaceId, row);
      await record(row, input.decision);
      return view({ ...row, decision: input.decision });
    });
  }
  async function destinations(workspaceId: string, userId: string) {
    return transaction(workspaceId, async tx => {
      const actor = await resolveHuman(tx, userId);
      const rows = z
        .array(destinationSchema.extend({ name: z.string() }))
        .parse(
          (
            await tx.client.query(
              `SELECT * FROM ${relation(tx, 'tf_slack_destinations')} WHERE enabled ORDER BY name,id LIMIT 100`,
            )
          ).rows,
        );
      const items = [];
      for (const row of rows) {
        const permissions: SlackAction['tool'][] = [];
        for (const tool of ['slack.message.send', 'slack.thread.reply', 'slack.reaction.add'] as const)
          if (await canAccessAsset(tx, actor, row.id, tool)) permissions.push(tool);
        if (permissions.length)
          items.push({ id: row.id, name: row.name, channel: row.channel, version: row.version, permissions });
      }
      return { destinations: items };
    });
  }
  async function destination(workspaceId: string, userId: string, id: string) {
    return transaction(workspaceId, async tx => {
      const actor = await resolveHuman(tx, userId);
      const row = await loadDestination(tx, actor, z.uuid().parse(id));
      const observed = await provider.observe(
        tx,
        workspaceId,
        actor,
        { installationId: row.installation_id, generation: row.generation, channel: row.channel, rootTs: '0.000000' },
        false,
      );
      if (!observed.channelName || !observed.archiveVerified) throw new AccessDenied();
      return {
        id: row.id,
        name: observed.channelName,
        channel: row.channel,
        teamId: observed.teamId,
        installationId: row.installation_id,
      };
    });
  }
  async function configureDestination(workspaceId: string, userId: string, value: unknown) {
    const input = z
      .strictObject({
        id: z.uuid(),
        channel: z.string().regex(/^[CG][A-Z0-9]{1,63}$/),
        name: z.string().trim().min(1).max(120),
        expectedVersion: z.number().int().nonnegative(),
        teamId: z.uuid(),
        enabled: z.boolean(),
      })
      .parse(value);
    return options.runtime.transaction(workspaceId, range, async tx => {
      await lockAuthorization(tx, 'write');
      const actor = await resolveHuman(tx, userId);
      const installation = z
        .object({ id: z.uuid(), generation: z.number() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT id,generation FROM ${relation(tx, 'tf_slack_installations')} WHERE app_id=$1 AND state='active'`,
              [options.appId],
            )
          ).rows[0],
        );
      // Installation managers configure destinations, granting sends only to teams they belong to. Admin status grants nothing.
      if (!installation || !(await canAccessSlackInstallation(tx, actor, installation.id, 'manage')))
        throw new AccessDenied();
      await requireTeamMember(tx, actor, input.teamId);
      await provider.observe(
        tx,
        workspaceId,
        actor,
        {
          installationId: installation.id,
          generation: installation.generation,
          channel: input.channel,
          rootTs: '0.000000',
        },
        false,
      );
      const result =
        input.expectedVersion === 0
          ? await tx.client.query(
              `INSERT INTO ${relation(tx, 'tf_slack_destinations')} (id,installation_id,generation,channel,name,enabled) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING version`,
              [input.id, installation.id, installation.generation, input.channel, input.name, input.enabled],
            )
          : await tx.client.query(
              `UPDATE ${relation(tx, 'tf_slack_destinations')} SET name=$2,enabled=$3,version=version+1 WHERE id=$1 AND version=$4 AND channel=$5 AND installation_id=$6 AND generation=$7 RETURNING version`,
              [
                input.id,
                input.name,
                input.enabled,
                input.expectedVersion,
                input.channel,
                installation.id,
                installation.generation,
              ],
            );
      if (!result.rowCount) throw new Error('slack-decision-conflict');
      await tx.client.query(
        `DELETE FROM ${relation(tx, 'tf_grants')} WHERE asset_id=$1 AND permission=ANY($2::text[])`,
        [input.id, ['slack.message.send', 'slack.thread.reply', 'slack.reaction.add']],
      );
      if (input.enabled)
        for (const permission of ['slack.message.send', 'slack.thread.reply', 'slack.reaction.add'])
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,$3)`,
            [input.teamId, input.id, permission],
          );
      return { id: input.id, version: z.number().parse(result.rows[0]?.version) };
    });
  }
  async function resolve(workspaceId: string, actor: HumanActor, value: unknown) {
    const input = slackResolveSchema.parse(value);
    return transaction(workspaceId, async tx => {
      await currentMember(tx, actor);
      const installation = z
        .object({ id: z.uuid(), generation: z.number().int() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT id,generation FROM ${relation(tx, 'tf_slack_installations')} WHERE app_id=$1 AND state='active'`,
              [options.appId],
            )
          ).rows[0],
        );
      if (!installation)
        return {
          error: 'slack-unavailable',
          instruction:
            'This workspace has not connected Slack. Ask a workspace admin to connect Slack in Integrations, then call slack.resolve again.',
        };
      const source = { installationId: installation.id, generation: installation.generation };
      try {
        await provider.identity(tx, actor, source);
        const name = input.name.replace(/^[#@]/, '').trim();
        const configured = [];
        if (input.kind === 'channel') {
          const rows = z
            .array(destinationSchema.extend({ name: z.string() }))
            .parse(
              (
                await tx.client.query(
                  `SELECT * FROM ${relation(tx, 'tf_slack_destinations')} WHERE installation_id=$1 AND generation=$2 AND enabled AND (lower(ltrim(name,'#'))=lower($3) OR channel=$3) ORDER BY id LIMIT 100`,
                  [installation.id, installation.generation, name],
                )
              ).rows,
            );
          for (const row of rows)
            if (await canAccessAsset(tx, actor, row.id, 'slack.message.send'))
              configured.push({ id: row.channel, name: row.name });
        }
        const found = configured.length
          ? { matches: configured, status: configured.length === 1 ? ('resolved' as const) : ('ambiguous' as const) }
          : await provider.search(tx, workspaceId, actor, source, input);
        if ('error' in found) return found;
        if (input.kind === 'user')
          return {
            ...found,
            instruction:
              found.status === 'ambiguous'
                ? 'Ask which person the requester means. Do not choose between matching people.'
                : found.status === 'not-found'
                  ? 'No visible Slack user matched. Check the name and try again.'
                  : 'Use the resolved user ID only for the requested purpose. User lookup does not create a permitted message destination.',
          };
        const matches = [];
        for (const match of found.matches) {
          const destination = destinationSchema
            .optional()
            .parse(
              (
                await tx.client.query(
                  `INSERT INTO ${relation(tx, 'tf_slack_destinations')} AS d (id,installation_id,generation,channel,name) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (installation_id,generation,channel) DO UPDATE SET name=EXCLUDED.name WHERE d.enabled RETURNING d.*`,
                  [randomUUID(), installation.id, installation.generation, match.id, match.name],
                )
              ).rows[0],
            );
          const allowed = destination && (await currentMember(tx, actor));
          if (found.status === 'resolved') {
            try {
              await provider.observe(
                tx,
                workspaceId,
                actor,
                { ...source, channel: match.id, rootTs: '0.000000' },
                false,
              );
            } catch (error) {
              if (error instanceof SlackChannelAccessError)
                return { error: error.code, channelId: match.id, instruction: error.instruction };
              throw error;
            }
          }
          matches.push({ ...match, ...(allowed ? { destinationId: destination.id } : {}) });
        }
        return {
          status: found.status,
          matches,
          instruction:
            found.status === 'ambiguous'
              ? 'Ask which channel the requester means.'
              : found.status === 'not-found'
                ? 'No visible Slack channel matched. Check the name and your channel access.'
                : matches[0]?.destinationId
                  ? 'Use destinationId to send.'
                  : 'This channel is disabled for sending. Ask a workspace admin to re-enable it.',
        };
      } catch (error) {
        if (error instanceof SlackApiError)
          return {
            error: error.code,
            instruction:
              error.code === 'provider-auth-rejected'
                ? 'Reconnect your Slack account in Integrations, then try again.'
                : 'Slack lookup did not complete. Try again later; do not guess an ID.',
          };
        if (error instanceof AccessDenied)
          return {
            error: 'slack-access-required',
            instruction: 'Check your Slack account integration and channel access, then try again.',
          };
        throw error;
      }
    });
  }
  async function conversationOrigin(tx: AgentTransaction, turnId: string, callId?: string) {
    return z
      .object({ id: z.uuid(), conversation_id: z.uuid(), action: slackActionSchema, sources: sourceDependenciesSchema })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT * FROM ${relation(tx, 'tf_slack_conversation_actions')} WHERE turn_id=$1 AND ($2::uuid IS NULL OR id=$2)`,
            [turnId, callId ?? null],
          )
        ).rows[0],
      );
  }
  // Human chat always posts as the requester. Workflows and agents use their saved sender choice.
  async function agentPolicy(
    tx: AgentTransaction,
    runId: string,
    callId: string,
  ): Promise<{ version: number; sender: SlackSender }> {
    const workflow = await workflowOrigin(tx, runId, callId);
    if (workflow)
      return { version: 0, sender: await workflows.slackSender(tx as Transaction, runId, workflow.step_id) };
    if (await conversationOrigin(tx, runId)) return { version: 0, sender: 'user' };
    const agent = z
      .object({ policy_version: z.number(), slack_sender: slackSenderSchema.default('user') })
      .parse(
        (
          await tx.client.query(
            `SELECT a.policy_version${hasSender(tx) ? ',a.slack_sender' : ''} FROM ${relation(tx, 'tf_agents')} a JOIN ${relation(tx, 'tf_agent_runs')} r ON r.agent_id=a.id WHERE r.id=$1`,
            [runId],
          )
        ).rows[0],
      );
    return { version: agent.policy_version, sender: agent.slack_sender };
  }
  async function conversation(
    context: {
      workspaceId: string;
      actor: HumanActor;
      callId: string;
      origin: { conversationId: string; turnId: string; sources: unknown };
    },
    value: unknown,
  ) {
    const action = slackActionSchema.parse(value);
    await transaction(context.workspaceId, async tx => {
      const actor = await turnRequester(tx, context.origin.conversationId, context.origin.turnId);
      if (actor.userId !== context.actor.userId || actor.membershipId !== context.actor.membershipId)
        throw new AccessDenied();
      await currentMember(tx, actor);
      const destination = await loadDestination(tx, actor, action.destinationId);
      const receipt = await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_conversation_tool_calls')} c JOIN ${relation(tx, 'tf_conversation_turns')} t ON t.id=c.turn_id WHERE c.id=$1 AND c.turn_id=$2 AND c.conversation_id=$3 AND c.tool=$4 AND c.status='running' AND t.status='processing' AND t.lease_until>clock_timestamp()`,
        [context.callId, context.origin.turnId, context.origin.conversationId, action.tool],
      );
      if (!receipt.rowCount) throw new AccessDenied();
      await provider.observe(tx, context.workspaceId, actor, source(destination, action), false);
      let sources = sourceDependenciesSchema.parse(context.origin.sources);
      await requireNoMcpDerived(tx, [
        { kind: 'private-conversation', conversationId: context.origin.conversationId },
        ...sources,
      ]);
      const prior = (
        await tx.client.query(
          `SELECT 1 FROM ${relation(tx, 'tf_conversation_turns')} WHERE conversation_id=$1 AND accepted_sequence<(SELECT accepted_sequence FROM ${relation(tx, 'tf_conversation_turns')} WHERE id=$2)`,
          [context.origin.conversationId, context.origin.turnId],
        )
      ).rowCount;
      if (!prior)
        sources = sources.filter(
          source => source.kind !== 'private-conversation' || source.conversationId !== context.origin.conversationId,
        );
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_slack_conversation_actions')} (id,conversation_id,turn_id,action,sources) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [context.callId, context.origin.conversationId, context.origin.turnId, action, JSON.stringify(sources)],
      );
    });
    const result = await execute(context.workspaceId, context.origin.turnId, context.callId, action);
    await notify(context.workspaceId, context.callId).catch(() => undefined);
    return result;
  }
  async function resumeConversation(workspaceId: string, turnId: string) {
    const origin = await transaction(workspaceId, tx => conversationOrigin(tx, turnId));
    if (!origin) throw new AccessDenied();
    const result = await execute(workspaceId, turnId, origin.id, origin.action);
    await notify(workspaceId, origin.id).catch(() => undefined);
    return result;
  }
  async function taskActions(workspaceId: string, userId: string, taskId: string) {
    const ids = await transaction(workspaceId, async tx => {
      const actor = await resolveHuman(tx, userId);
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${relation(tx, 'tf_agent_tasks')} WHERE id=$1 AND owner_user_id=$2 AND owner_membership_id=$3`,
            [z.uuid().parse(taskId), actor.userId, actor.membershipId],
          )
        ).rowCount
      )
        throw new AccessDenied();
      return z
        .array(z.object({ id: z.uuid() }))
        .parse(
          (
            await tx.client.query(
              `SELECT a.id FROM ${relation(tx, 'tf_slack_actions')} a JOIN ${relation(tx, 'tf_agent_runs')} r ON r.id=a.run_id WHERE r.task_id=$1 ORDER BY a.created_at,a.id LIMIT 100`,
              [taskId],
            )
          ).rows,
        );
    });
    const actions = [];
    for (const { id } of ids) actions.push(await read(workspaceId, userId, id));
    return { actions };
  }
  async function workflowOrigin(tx: AgentTransaction, runId: string, callId?: string) {
    if (!('commonVersion' in tx) || Number(tx.commonVersion) < 1) return undefined;
    return z
      .object({
        id: z.uuid(),
        workflow_id: z.uuid(),
        revision: z.uuid(),
        step_id: z.string(),
        action: slackActionSchema,
      })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT o.* FROM ${relation(tx, 'tf_slack_workflow_actions')} o JOIN ${relation(tx, 'tf_workflow_steps')} s ON s.run_id=o.run_id AND s.step_id=o.step_id WHERE o.run_id=$1 AND ($2::uuid IS NOT NULL AND o.id=$2 OR $2::uuid IS NULL AND s.status='waiting') ORDER BY o.step_id LIMIT 1`,
            [runId, callId ?? null],
          )
        ).rows[0],
      );
  }
  async function workflow(workspaceId: string, runId: string, stepId: string, actionId: string) {
    try {
      const action = await transaction(workspaceId, async tx => {
        const existing = await workflowOrigin(tx, runId, actionId);
        if (existing) {
          if (existing.step_id !== stepId) throw new AccessDenied();
          return existing.action;
        }
        const origin = await workflows.slackOrigin(tx, runId, stepId);
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_slack_workflow_actions')} (id,run_id,workflow_id,revision,step_id,action) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [actionId, runId, origin.workflowId, origin.revision, stepId, origin.action],
        );
        const stored = await workflowOrigin(tx, runId, actionId);
        if (!stored || stored.step_id !== stepId || canonicalJson(stored.action) !== canonicalJson(origin.action))
          throw new AccessDenied();
        return origin.action;
      });
      const result = await execute(workspaceId, runId, actionId, action);
      try {
        await notify(workspaceId, actionId);
      } catch (error) {
        log('warn', 'activity', 'call_failed', {
          operation: 'workflow.slack.notify',
          outcome: 'error',
          'error.type': errorType(error),
        });
      }
      return result;
    } catch (error) {
      if (!(error instanceof AccessDenied)) throw error;
      return {
        id: actionId,
        status: 'revoked' as const,
        expiresAt: new Date().toISOString(),
        nextAttemptAt: new Date().toISOString(),
        sentMessageTs: null,
      };
    }
  }
  return {
    prepare,
    execute,
    read,
    decide,
    notify,
    destinations,
    destination,
    configureDestination,
    resolve,
    conversation,
    resumeConversation,
    taskActions,
    workflow,
    /** Checks a Slack turn's audience for chat row drafts asked from that thread; absent outside Slack replies. */
    turnAudience: options.audienceSources,
  };
}

export function createSlackActionDecision(
  options: Options & { resolveConfirmationCredential: (workspaceId: string) => Promise<string> },
) {
  const service = createSlackActions(options);
  return (workspaceId: string, userId: string, callId: string, value: unknown) =>
    service.decide(workspaceId, userId, callId, value, async (row, decision) => {
      const connectionString = await options.resolveConfirmationCredential(workspaceId);
      await withMaintenanceTransaction({
        connectionString,
        workspaceId,
        capability: 'confirmation',
        operation: async tx => {
          const match = await tx.client.query(
            `SELECT 1 FROM ${relation(tx, 'tf_slack_actions')} WHERE id=$1 AND digest=$2 AND membership_id=$3 AND expires_at>clock_timestamp()`,
            [row.id, row.digest, row.membership_id],
          );
          if (!match.rowCount) throw new AccessDenied();
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_slack_action_decisions')} (action_id,digest,membership_id,decision) VALUES ($1,$2,$3,$4)`,
            [row.id, row.digest, row.membership_id, decision],
          );
        },
      });
    });
}
