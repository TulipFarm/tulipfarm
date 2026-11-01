import { createHash, randomUUID } from 'node:crypto';
import type { SlackBlock } from '@tulipfarm/slack-presentation';
import { z } from 'zod';
import {
  AccessDenied,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { ConversationConflict } from '@tulipfarm/conversations/contracts';
import { log } from '@tulipfarm/observability';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import {
  followUpChainHours,
  followUpChainLimit,
  followUpMaximumMinutes,
  followUpReaction,
  followUpReactionMinutes,
  followUpViewSchema,
  slackFollowUpCancelAction,
  type FollowUpView,
  type ScheduleFollowUpCall,
} from './follow-up-contracts.ts';
import { withHuman } from './saved-policy.ts';
import { relation, type AgentStorage } from './store.ts';

/** The first common migration with `tf_follow_ups`. */
export const followUpsVersion = 27;
const pendingLimit = 25;
const claimBatch = 20;
const reclaimAfterMinutes = 2;
// A follow-up whose turn could not be started for this long after it was due is given up rather than run late.
const abandonAfterMinutes = 60;

type Transaction = AuthorizationTransaction & { commonVersion?: number };
const installed = (tx: Transaction) => Number(tx.commonVersion ?? 0) >= followUpsVersion;

const rowSchema = z.object({
  id: z.uuid(),
  membership_id: z.uuid(),
  user_id: z.string(),
  surface: z.enum(['chat', 'slack']),
  origin: z.enum(['chat', 'slack-mention', 'slack-reaction']),
  conversation_id: z.uuid().nullable(),
  slack_installation_id: z.uuid().nullable(),
  slack_generation: z.number().int().nullable(),
  slack_channel: z.string().nullable(),
  slack_thread_ts: z.string().nullable(),
  slack_item_ts: z.string().nullable(),
  slack_parent_event_id: z.uuid().nullable(),
  instruction: z.string(),
  due_at: z.date(),
  timezone: z.string().nullable(),
  status: followUpViewSchema.shape.status,
  chain_root_id: z.uuid(),
  chain_depth: z.number().int(),
  chain_started_at: z.date(),
  created_at: z.date(),
  failure_reason: z.string().nullable(),
});
type FollowUpRow = z.infer<typeof rowSchema>;

export function followUpView(row: FollowUpRow): FollowUpView {
  return {
    id: row.id,
    instruction: row.instruction,
    dueAt: row.due_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    timezone: row.timezone,
    status: row.status,
    surface: row.surface,
    origin: row.origin,
    chainDepth: row.chain_depth,
    failureReason: row.failure_reason,
  };
}

/** The same tool call always names the same follow-up, so a replayed call never schedules twice. */
function deterministicId(seed: string) {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16] ?? '0', 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function validTimeZone(value: string | undefined) {
  if (!value) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

function localTime(row: Pick<FollowUpRow, 'due_at' | 'timezone'>) {
  return row.due_at.toLocaleString('en-GB', {
    timeZone: row.timezone ?? 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** The first line a fired follow-up's turn reads, so the model knows nobody is waiting live for questions. */
export function followUpPrompt(row: Pick<FollowUpRow, 'instruction' | 'created_at' | 'chain_depth'>) {
  return [
    `Scheduled follow-up, requested at ${row.created_at.toISOString()} (follow-up ${row.chain_depth} of at most ${followUpChainLimit} in its chain).`,
    'The requester is not watching live. Do the instruction now with fresh data, using your normal tools and their access, and report the result. Do not ask questions first; if something blocks you, say what and stop.',
    `Instruction: ${row.instruction}`,
  ].join('\n');
}

const refused = (reason: string, instruction: string) => ({ status: 'not-scheduled' as const, reason, instruction });

async function readRow(tx: Transaction, id: string) {
  const row = (await tx.client.query(`SELECT * FROM ${relation(tx, 'tf_follow_ups')} WHERE id=$1`, [id])).rows[0];
  return row ? rowSchema.parse(row) : undefined;
}

type Binding =
  | { surface: 'chat'; conversationId: string; parent: FollowUpRow | undefined }
  | {
      surface: 'slack';
      /** The default agent's request in a channel thread; null in a direct message thread. */
      eventId: string | null;
      installationId: string;
      generation: number;
      channel: string;
      threadTs: string;
      parent: FollowUpRow | undefined;
    };

/** Where a turn's follow-ups run: its own chat, or the Slack thread the default agent answered. */
async function bind(
  tx: Transaction,
  actor: HumanActor,
  origin: { conversationId: string; turnId: string },
): Promise<Binding | null> {
  const slack = z
    .object({
      event_id: z.uuid(),
      installation_id: z.uuid(),
      generation: z.number().int(),
      channel: z.string(),
      root_ts: z.string(),
      membership_id: z.uuid(),
    })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT t.event_id,e.installation_id,e.generation,r.channel,r.root_ts,i.membership_id FROM ${relation(tx, 'tf_slack_default_turns')} t
      JOIN ${relation(tx, 'tf_slack_events')} e ON e.id=t.event_id JOIN ${relation(tx, 'tf_slack_agent_branches')} b ON b.id=t.branch_id
      JOIN ${relation(tx, 'tf_slack_channel_roots')} r ON r.id=b.root_id JOIN ${relation(tx, 'tf_slack_identities')} i ON i.id=b.identity_id
      WHERE t.conversation_id=$1 AND t.turn_id=$2`,
          [origin.conversationId, origin.turnId],
        )
      ).rows[0],
    );
  if (slack) {
    if (slack.membership_id !== actor.membershipId) throw new AccessDenied();
    const parent = (
      await tx.client.query(`SELECT * FROM ${relation(tx, 'tf_follow_ups')} WHERE fired_event_id=$1`, [slack.event_id])
    ).rows[0];
    return {
      surface: 'slack',
      eventId: slack.event_id,
      installationId: slack.installation_id,
      generation: slack.generation,
      channel: slack.channel,
      threadTs: slack.root_ts,
      parent: parent ? rowSchema.parse(parent) : undefined,
    };
  }
  // A direct message thread with the app is one chat whose replies go back to that Slack thread.
  const dm = z
    .object({
      installation_id: z.uuid(),
      generation: z.number().int(),
      channel: z.string(),
      root_ts: z.string(),
      membership_id: z.uuid(),
    })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT d.installation_id,d.generation,d.channel,d.root_ts,i.membership_id FROM ${relation(tx, 'tf_slack_dm_roots')} d
      JOIN ${relation(tx, 'tf_slack_identities')} i ON i.id=d.identity_id WHERE d.conversation_id=$1`,
          [origin.conversationId],
        )
      ).rows[0],
    );
  if (dm) {
    if (dm.membership_id !== actor.membershipId) throw new AccessDenied();
    const parent = (
      await tx.client.query(
        `SELECT f.* FROM ${relation(tx, 'tf_follow_ups')} f JOIN ${relation(tx, 'tf_slack_dm_events')} d ON d.event_id=f.fired_event_id WHERE d.turn_id=$1 AND d.conversation_id=$2`,
        [origin.turnId, origin.conversationId],
      )
    ).rows[0];
    return {
      surface: 'slack',
      eventId: null,
      installationId: dm.installation_id,
      generation: dm.generation,
      channel: dm.channel,
      threadTs: dm.root_ts,
      parent: parent ? rowSchema.parse(parent) : undefined,
    };
  }
  const chat = await tx.client.query(
    `SELECT 1 FROM ${relation(tx, 'tf_conversations')} c WHERE c.id=$1 AND c.kind='private' AND c.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_slack_default_turns')} s WHERE s.conversation_id=c.id)`,
    [origin.conversationId],
  );
  if (!chat.rowCount) return null;
  const parent = (
    await tx.client.query(
      `SELECT f.* FROM ${relation(tx, 'tf_follow_ups')} f JOIN ${relation(tx, 'tf_conversation_turns')} t ON t.source_message_id=f.fired_message_id WHERE t.id=$1 AND t.conversation_id=$2`,
      [origin.turnId, origin.conversationId],
    )
  ).rows[0];
  return {
    surface: 'chat',
    conversationId: origin.conversationId,
    parent: parent ? rowSchema.parse(parent) : undefined,
  };
}

function bindingScope(binding: Binding, membershipId: string): { where: string; values: unknown[] } {
  return binding.surface === 'chat'
    ? { where: 'conversation_id=$1 AND membership_id=$2', values: [binding.conversationId, membershipId] }
    : {
        where: `surface='slack' AND slack_installation_id=$1 AND slack_channel=$2 AND slack_thread_ts=$3 AND membership_id=$4`,
        values: [binding.installationId, binding.channel, binding.threadTs, membershipId],
      };
}

async function audit(tx: Transaction, actorId: string, operation: string, subjectId: string) {
  await tx.client.query(
    `INSERT INTO ${relation(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id,created_at) VALUES ($1,$2,$3,$4,clock_timestamp())`,
    [randomUUID(), actorId, operation, subjectId],
  );
}

export type FollowUpOrigin = { conversationId: string; turnId: string };
export type ChatFollowUpSend = (
  workspaceId: string,
  userId: string,
  chatId: string,
  value: unknown,
) => Promise<{ messageId: string }>;

export function createFollowUps(runtime: AgentStorage) {
  async function schedule(
    workspaceId: string,
    actor: HumanActor,
    callId: string,
    origin: FollowUpOrigin,
    call: ScheduleFollowUpCall,
  ) {
    return withHuman(runtime, workspaceId, actor, 'write', async (tx, actor) => {
      if (!installed(tx))
        return refused(
          'unavailable',
          'Follow-ups are not available in this workspace yet. Tell the person it could not be scheduled, and do not do the deferred work now.',
        );
      const id = deterministicId(`follow-up:${origin.turnId}:${callId}`);
      const existing = await readRow(tx, id);
      if (existing) return { status: 'scheduled' as const, followUp: followUpView(existing) };
      const binding = await bind(tx, actor, origin);
      if (!binding)
        return refused(
          'unsupported-surface',
          'Follow-ups work only in a TulipFarm chat or a Slack thread answered by the TulipFarm app. Tell the person it could not be scheduled here; do not do the deferred work now.',
        );
      if ((call.delayMinutes === undefined) === (call.at === undefined))
        return refused('invalid-time', 'Give exactly one of delayMinutes or at, then call followups.schedule again.');
      const now = z.date().parse((await tx.client.query('SELECT clock_timestamp() AS now')).rows[0]?.now);
      let due = call.at ? new Date(call.at) : new Date(now.getTime() + (call.delayMinutes ?? 0) * 60_000);
      const minutes = (due.getTime() - now.getTime()) / 60_000;
      // A model-computed time a few seconds short of a minute still means "in a minute".
      if (minutes < 0.9)
        return refused(
          'too-soon',
          'Follow-ups can be scheduled from 1 minute to 24 hours from now; this time is less than 1 minute away. Tell the person this limit. If the time has passed or is now, do the work now instead, or ask for a later time.',
        );
      if (minutes > followUpMaximumMinutes + 1)
        return refused(
          'too-late',
          'Follow-ups can be scheduled from 1 minute to 24 hours from now; this time is more than 24 hours away. Tell the person this limit and that it was not scheduled; for later or repeating work suggest an agent schedule or a workflow.',
        );
      if (due.getTime() < now.getTime() + 60_000) due = new Date(now.getTime() + 60_000);
      const parent = binding.parent;
      const depth = parent ? parent.chain_depth + 1 : 1;
      const chainStarted = parent ? parent.chain_started_at : now;
      if (
        depth > followUpChainLimit ||
        due.getTime() > chainStarted.getTime() + followUpChainHours * 3_600_000 ||
        (parent && parent.membership_id !== actor.membershipId)
      )
        return refused(
          'chain-limit',
          `This chain of follow-ups reached its limit of ${followUpChainLimit} follow-ups or ${followUpChainHours} hours since the first request. Do not schedule another. Report the current result to the person now and say they can ask again.`,
        );
      const pending = Number(
        (
          await tx.client.query(
            `SELECT count(*)::int AS n FROM ${relation(tx, 'tf_follow_ups')} WHERE membership_id=$1 AND status IN ('pending','claimed')`,
            [actor.membershipId],
          )
        ).rows[0]?.n ?? 0,
      );
      if (pending >= pendingLimit)
        return refused(
          'too-many-pending',
          `The person already has ${pendingLimit} pending follow-ups. Tell them to cancel some first; do not do the deferred work now.`,
        );
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_follow_ups')} (id,membership_id,user_id,surface,origin,conversation_id,origin_turn_id,slack_installation_id,slack_generation,slack_channel,slack_thread_ts,slack_parent_event_id,instruction,due_at,timezone,chain_root_id,chain_depth,chain_started_at,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          id,
          actor.membershipId,
          actor.userId,
          binding.surface,
          binding.surface === 'chat' ? 'chat' : 'slack-mention',
          binding.surface === 'chat' ? binding.conversationId : null,
          origin.turnId,
          binding.surface === 'slack' ? binding.installationId : null,
          binding.surface === 'slack' ? binding.generation : null,
          binding.surface === 'slack' ? binding.channel : null,
          binding.surface === 'slack' ? binding.threadTs : null,
          binding.surface === 'slack' ? binding.eventId : null,
          call.instruction,
          due,
          validTimeZone(call.timezone) ?? parent?.timezone ?? null,
          parent?.chain_root_id ?? id,
          depth,
          chainStarted,
          now,
        ],
      );
      await audit(tx, actor.membershipId, 'agent.follow-up.schedule', id);
      const row = await readRow(tx, id);
      if (!row) throw new Error('follow-up-missing');
      return {
        status: 'scheduled' as const,
        followUp: followUpView(row),
        instruction: `Saved. It runs at ${localTime(row)} as a new turn here. Do not do the deferred work now. Confirm the time to the person; they can cancel it ${binding.surface === 'chat' ? 'from the card' : 'with the Cancel button'} or by asking.`,
      };
    });
  }

  async function list(workspaceId: string, actor: HumanActor, origin: FollowUpOrigin) {
    return withHuman(runtime, workspaceId, actor, 'read', async (tx, actor) => {
      if (!installed(tx)) return { followUps: [] };
      const binding = await bind(tx, actor, origin);
      if (!binding) return { followUps: [] };
      const scope = bindingScope(binding, actor.membershipId);
      const rows = z.array(rowSchema).parse(
        (
          await tx.client.query(
            `SELECT * FROM ${relation(tx, 'tf_follow_ups')} WHERE ${scope.where}
          AND (status IN ('pending','claimed') OR created_at > clock_timestamp()-interval '24 hours') ORDER BY due_at,id LIMIT 30`,
            scope.values,
          )
        ).rows,
      );
      return { followUps: rows.map(followUpView) };
    });
  }

  async function cancelRow(tx: Transaction, actor: HumanActor, id: string, where = 'true', values: unknown[] = []) {
    const cancelled = await tx.client.query(
      `UPDATE ${relation(tx, 'tf_follow_ups')} SET status='cancelled',finished_at=clock_timestamp() WHERE id=$1 AND membership_id=$2 AND status='pending' AND ${where} RETURNING id`,
      [id, actor.membershipId, ...values],
    );
    if (cancelled.rowCount) await audit(tx, actor.membershipId, 'agent.follow-up.cancel', id);
    const row = await readRow(tx, id);
    if (!row || row.membership_id !== actor.membershipId) throw new AccessDenied();
    return row;
  }

  /** The agent's cancel: only the requester's own follow-ups of this chat or thread. */
  async function cancel(workspaceId: string, actor: HumanActor, origin: FollowUpOrigin, followUpId: string) {
    return withHuman(runtime, workspaceId, actor, 'write', async (tx, actor) => {
      if (!installed(tx)) return { status: 'not-found' as const };
      const binding = await bind(tx, actor, origin);
      if (!binding) return { status: 'not-found' as const };
      const scope = bindingScope(binding, actor.membershipId);
      const inScope = await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_follow_ups')} WHERE id=$${scope.values.length + 1} AND ${scope.where}`,
        [...scope.values, followUpId],
      );
      if (!inScope.rowCount) return { status: 'not-found' as const };
      const row = await cancelRow(tx, actor, followUpId);
      return { status: row.status === 'cancelled' ? ('cancelled' as const) : row.status, followUp: followUpView(row) };
    });
  }

  /** A chat's follow-up card, for its requester only. */
  async function readInChat(workspaceId: string, userId: string, chatId: string, followUpId: string) {
    return withHuman(runtime, workspaceId, userId, 'read', async (tx, actor) => {
      if (!installed(tx)) throw new AccessDenied();
      const row = await readRow(tx, followUpId);
      if (!row || row.conversation_id !== chatId || row.membership_id !== actor.membershipId) throw new AccessDenied();
      return followUpView(row);
    });
  }

  async function cancelInChat(workspaceId: string, userId: string, chatId: string, followUpId: string) {
    return withHuman(runtime, workspaceId, userId, 'write', async (tx, actor) => {
      if (!installed(tx)) throw new AccessDenied();
      return followUpView(await cancelRow(tx, actor, followUpId, 'conversation_id=$3', [chatId]));
    });
  }

  /** The Cancel button under a Slack confirmation; only the requester's own linked Slack account may press it. */
  async function cancelFromSlack(
    workspaceId: string,
    followUpId: string,
    clicker: { appId: string; teamId: string; slackUserId: string },
  ) {
    return runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      if (!installed(tx)) throw new AccessDenied();
      const owner = z
        .object({ user_id: z.string(), membership_id: z.uuid() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT p.user_id,p.membership_id FROM ${relation(tx, 'tf_follow_ups')} f
          JOIN ${relation(tx, 'tf_slack_identities')} p ON p.membership_id=f.membership_id AND p.installation_id=f.slack_installation_id
          JOIN ${relation(tx, 'tf_slack_installations')} i ON i.id=p.installation_id AND i.generation=p.generation
          WHERE f.id=$1 AND i.app_id=$2 AND i.team_id=$3 AND i.state='active' AND p.state='authorized' AND p.slack_user_id=$4`,
              [followUpId, clicker.appId, clicker.teamId, clicker.slackUserId],
            )
          ).rows[0],
        );
      if (!owner) throw new AccessDenied();
      const actor = await resolveHuman(tx, owner.user_id);
      if (actor.membershipId !== owner.membership_id) throw new AccessDenied();
      return followUpView(await cancelRow(tx, actor, followUpId));
    });
  }

  /**
   * Starts every due follow-up once. Slack follow-ups are held as new Slack requests in the same transaction, so the
   * Slack worker admits them with every check a new mention passes. Chat follow-ups are sent as the requester through
   * `send`, idempotent on the follow-up's id, so a crash between claim and send retries without a second message.
   * Returns the chats that got a new turn.
   */
  async function due(workspaceId: string, send: ChatFollowUpSend) {
    const claimed = await runtime.transaction(workspaceId, commonCompatibility, async tx => {
      if (!installed(tx)) return [];
      await lockAuthorization(tx, 'write');
      const lost = await tx.client.query(
        `UPDATE ${relation(tx, 'tf_follow_ups')} f SET status='skipped',failure_reason='requester-access-lost',finished_at=clock_timestamp()
        WHERE f.status IN ('pending','claimed') AND f.due_at<=clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_memberships')} m WHERE m.id=f.membership_id AND m.user_id=f.user_id AND m.removed_at IS NULL)
        RETURNING f.id`,
      );
      for (const row of lost.rows)
        await audit(tx, 'system:follow-up-sweep', 'agent.follow-up.skip.requester-access-lost', row.id);
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_follow_ups')} SET status='failed',failure_reason='not-started',finished_at=clock_timestamp()
        WHERE status='claimed' AND due_at < clock_timestamp()-interval '${abandonAfterMinutes} minutes'`,
      );
      const rows = z.array(rowSchema).parse(
        (
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_follow_ups')} SET status='claimed',claimed_at=clock_timestamp()
          WHERE id IN (SELECT id FROM ${relation(tx, 'tf_follow_ups')}
            WHERE (status='pending' AND due_at<=clock_timestamp()) OR (status='claimed' AND claimed_at < clock_timestamp()-interval '${reclaimAfterMinutes} minutes')
            ORDER BY due_at,id LIMIT ${claimBatch} FOR UPDATE SKIP LOCKED)
          RETURNING *`,
          )
        ).rows,
      );
      const chats: FollowUpRow[] = [];
      for (const row of rows) {
        if (row.surface === 'chat') chats.push(row);
        else await fireSlack(tx, row);
      }
      return chats;
    });
    const fired: string[] = [];
    for (const row of claimed) {
      try {
        const sent = await send(workspaceId, row.user_id, z.uuid().parse(row.conversation_id), {
          commandId: row.id,
          messageId: row.id,
          ...(row.timezone ? { timeZone: row.timezone } : {}),
          parts: [{ kind: 'text', text: followUpPrompt(row) }],
        });
        await finish(workspaceId, row.id, { status: 'fired', messageId: sent.messageId });
        fired.push(z.uuid().parse(row.conversation_id));
      } catch (error) {
        if (error instanceof AccessDenied)
          await finish(workspaceId, row.id, { status: 'skipped', reason: 'requester-access-lost' });
        else if (error instanceof ConversationConflict)
          await finish(workspaceId, row.id, { status: 'failed', reason: error.code });
        else {
          // Left claimed: the next sweep after a short wait sends it again under the same command.
          log('warn', 'dependency', 'call_failed', { operation: 'agent.follow-up.fire', outcome: 'retry' });
        }
      }
    }
    return fired;
  }

  async function finish(
    workspaceId: string,
    id: string,
    outcome: { status: 'fired'; messageId: string } | { status: 'skipped' | 'failed'; reason: string },
  ) {
    await runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_follow_ups')} SET status=$2,fired_message_id=$3,failure_reason=$4,finished_at=clock_timestamp() WHERE id=$1 AND status='claimed'`,
        [
          id,
          outcome.status,
          outcome.status === 'fired' ? outcome.messageId : null,
          outcome.status === 'fired' ? null : outcome.reason.slice(0, 200),
        ],
      );
      if (outcome.status !== 'fired')
        await audit(tx, 'system:follow-up-sweep', `agent.follow-up.${outcome.status}.${outcome.reason}`, id);
    });
  }

  async function fireSlack(tx: Transaction, row: FollowUpRow) {
    const fail = async (status: 'failed' | 'skipped', reason: string) => {
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_follow_ups')} SET status=$2,failure_reason=$3,finished_at=clock_timestamp() WHERE id=$1`,
        [row.id, status, reason],
      );
      await audit(tx, 'system:follow-up-sweep', `agent.follow-up.${status}.${reason}`, row.id);
    };
    const eventId = deterministicId(`follow-up-event:${row.id}`);
    let payload: Record<string, unknown>, rootId: string, installationId: string, generation: number;
    if (row.slack_channel?.startsWith('D')) {
      // Held like a new direct message in the same thread, so the app's direct message intake admits it as a turn.
      installationId = z.uuid().parse(row.slack_installation_id);
      generation = z.number().int().parse(row.slack_generation);
      const slackUserId = await linkedSlackUser(tx, installationId, generation, row.membership_id);
      if (!slackUserId) return fail('skipped', 'requester-access-lost');
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_slack_events')} (id,installation_id,generation,event_id,semantic_key,event_time,payload,disposition)
        VALUES ($1,$2,$3,$4,$4,$5,$6,'held') ON CONFLICT DO NOTHING`,
        [
          eventId,
          installationId,
          generation,
          `follow-up:${row.id}`,
          Math.floor(Date.now() / 1000),
          {
            type: 'message',
            user: slackUserId,
            channel: row.slack_channel,
            ts: syntheticTs(),
            thread_ts: row.slack_thread_ts,
            text: followUpPrompt(row),
          },
        ],
      );
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_follow_ups')} SET status='fired',fired_event_id=$2,finished_at=clock_timestamp() WHERE id=$1`,
        [row.id, eventId],
      );
      return;
    }
    if (row.origin === 'slack-reaction') {
      const root = await reactionRoot(tx, row);
      if (!root) return fail('skipped', 'thread-has-another-agent');
      ({ rootId, installationId, generation } = root);
      payload = {
        type: 'message',
        user: root.slackUserId,
        channel: row.slack_channel,
        ts: syntheticTs(),
        thread_ts: row.slack_thread_ts,
        text: `:${followUpReaction}:`,
        tf_reaction: { reaction: followUpReaction, prompt: row.instruction.slice(0, 2000), itemTs: row.slack_item_ts },
      };
    } else {
      const parent = z
        .object({
          installation_id: z.uuid(),
          generation: z.number().int(),
          payload: z.record(z.string(), z.unknown()),
          root_id: z.uuid(),
        })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT e.installation_id,e.generation,e.payload,b.root_id FROM ${relation(tx, 'tf_slack_default_turns')} t
          JOIN ${relation(tx, 'tf_slack_events')} e ON e.id=t.event_id JOIN ${relation(tx, 'tf_slack_agent_branches')} b ON b.id=t.branch_id
          WHERE t.event_id=$1`,
              [row.slack_parent_event_id],
            )
          ).rows[0],
        );
      if (!parent) return fail('failed', 'thread-unavailable');
      ({ installation_id: installationId, generation, root_id: rootId } = parent);
      payload = { ...parent.payload, tf_followup: { parentEventId: row.slack_parent_event_id, text: row.instruction } };
    }
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_slack_events')} (id,installation_id,generation,event_id,semantic_key,event_time,payload,disposition)
      VALUES ($1,$2,$3,$4,$4,$5,$6,'held') ON CONFLICT DO NOTHING`,
      [eventId, installationId, generation, `follow-up:${row.id}`, Math.floor(Date.now() / 1000), payload],
    );
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_slack_channel_invocations')} (event_id,root_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [eventId, rootId],
    );
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_follow_ups')} SET status='fired',fired_event_id=$2,finished_at=clock_timestamp() WHERE id=$1`,
      [row.id, eventId],
    );
  }

  return { schedule, list, cancel, readInChat, cancelInChat, cancelFromSlack, due };
}

function syntheticTs() {
  const now = Date.now();
  return `${Math.floor(now / 1000)}.${String((now % 1000) * 1000 + Math.floor(Math.random() * 1000)).padStart(6, '0')}`;
}

async function linkedSlackUser(tx: Transaction, installationId: string, generation: number, membershipId: string) {
  return z
    .string()
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT slack_user_id FROM ${relation(tx, 'tf_slack_identities')} WHERE installation_id=$1 AND generation=$2 AND membership_id=$3 AND state='authorized'`,
          [installationId, generation, membershipId],
        )
      ).rows[0]?.slack_user_id,
    );
}

/** The default agent's root for a reacted thread, created like a reaction request's; null when another agent owns it. */
async function reactionRoot(tx: Transaction, row: FollowUpRow) {
  const installationId = z.uuid().parse(row.slack_installation_id),
    generation = z.number().int().parse(row.slack_generation),
    channel = z.string().parse(row.slack_channel),
    rootTs = z.string().parse(row.slack_thread_ts);
  const slackUserId = await linkedSlackUser(tx, installationId, generation, row.membership_id);
  if (!slackUserId) return null;
  await tx.client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,93575))`, [
    `${tx.schema}:${installationId}:${generation}:${channel}:${rootTs}`,
  ]);
  const existing = z
    .object({ id: z.uuid(), agent_id: z.uuid().nullable() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT id,agent_id FROM ${relation(tx, 'tf_slack_channel_roots')} WHERE installation_id=$1 AND generation=$2 AND channel=$3 AND root_ts=$4`,
          [installationId, generation, channel, rootTs],
        )
      ).rows[0],
    );
  if (existing) return existing.agent_id ? null : { rootId: existing.id, installationId, generation, slackUserId };
  if (await attachedAgent(tx, installationId, generation, channel)) return null;
  const rootId = randomUUID();
  await tx.client.query(
    `INSERT INTO ${relation(tx, 'tf_slack_channel_roots')} (id,installation_id,generation,channel,root_ts,agent_id) VALUES ($1,$2,$3,$4,$5,NULL)`,
    [rootId, installationId, generation, channel, rootTs],
  );
  return { rootId, installationId, generation, slackUserId };
}

async function attachedAgent(tx: Transaction, installationId: string, generation: number, channel: string) {
  return Boolean(
    (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_slack_channel_attachments')} WHERE installation_id=$1 AND generation=$2 AND channel=$3 AND agent_id IS NOT NULL`,
        [installationId, generation, channel],
      )
    ).rowCount,
  );
}

const reactionKey = (installationId: string, channel: string, itemTs: string, user: string) =>
  `${installationId}:${channel}:${itemTs}:${user}`;

/**
 * An ⏰ reaction from a linked member reminds them about that message in its thread an hour later. Unknown or unlinked
 * reactors, and channels that another agent answers, are ignored silently. Returns the new follow-up, if any.
 */
export async function createReactionFollowUp(
  tx: Transaction,
  input: {
    installationId: string;
    generation: number;
    user: string;
    channel: string;
    itemTs: string;
    rootTs: string;
  },
) {
  if (!installed(tx)) return null;
  const member = z
    .object({ membership_id: z.uuid(), user_id: z.string() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT i.membership_id,i.user_id FROM ${relation(tx, 'tf_slack_identities')} i JOIN ${relation(tx, 'tf_memberships')} m ON m.id=i.membership_id AND m.user_id=i.user_id AND m.removed_at IS NULL
        WHERE i.installation_id=$1 AND i.generation=$2 AND i.slack_user_id=$3 AND i.state='authorized'`,
          [input.installationId, input.generation, input.user],
        )
      ).rows[0],
    );
  if (!member) return null;
  const root = z
    .object({ agent_id: z.uuid().nullable() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT agent_id FROM ${relation(tx, 'tf_slack_channel_roots')} WHERE installation_id=$1 AND generation=$2 AND channel=$3 AND root_ts=$4`,
          [input.installationId, input.generation, input.channel, input.rootTs],
        )
      ).rows[0],
    );
  if (root?.agent_id || (!root && (await attachedAgent(tx, input.installationId, input.generation, input.channel))))
    return null;
  const pending = Number(
    (
      await tx.client.query(
        `SELECT count(*)::int AS n FROM ${relation(tx, 'tf_follow_ups')} WHERE membership_id=$1 AND status IN ('pending','claimed')`,
        [member.membership_id],
      )
    ).rows[0]?.n ?? 0,
  );
  if (pending >= pendingLimit) return null;
  const id = randomUUID();
  const inserted = await tx.client.query(
    `INSERT INTO ${relation(tx, 'tf_follow_ups')} (id,membership_id,user_id,surface,origin,slack_installation_id,slack_generation,slack_channel,slack_thread_ts,slack_item_ts,reaction_key,instruction,due_at,chain_root_id,chain_depth,chain_started_at)
    VALUES ($1,$2,$3,'slack','slack-reaction',$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+$11*interval '1 minute',$1,1,clock_timestamp())
    ON CONFLICT (reaction_key) WHERE status='pending' DO NOTHING RETURNING *`,
    [
      id,
      member.membership_id,
      member.user_id,
      input.installationId,
      input.generation,
      input.channel,
      input.rootTs,
      input.itemTs,
      reactionKey(input.installationId, input.channel, input.itemTs, input.user),
      `Remind <@${input.user}> about the message with ts ${input.itemTs} in this thread, which they marked with :${followUpReaction}: an hour ago. Mention them and say briefly what the message was about.`,
      followUpReactionMinutes,
    ],
  );
  const row = inserted.rows[0];
  if (!row) return null;
  await audit(tx, member.membership_id, 'agent.follow-up.schedule', id);
  return rowSchema.parse(row);
}

/** Removing the ⏰ reaction before its reminder runs cancels that reminder. */
export async function cancelReactionFollowUp(
  tx: Transaction,
  input: { installationId: string; user: string; channel: string; itemTs: string },
) {
  if (!installed(tx)) return;
  const cancelled = await tx.client.query(
    `UPDATE ${relation(tx, 'tf_follow_ups')} SET status='cancelled',finished_at=clock_timestamp() WHERE reaction_key=$1 AND status='pending' RETURNING id,membership_id`,
    [reactionKey(input.installationId, input.channel, input.itemTs, input.user)],
  );
  for (const row of cancelled.rows) await audit(tx, row.membership_id, 'agent.follow-up.cancel', row.id);
}

/** The follow-up a held Slack request was started by, if it was one. */
export async function scheduledFollowUp(tx: Transaction, eventId: string) {
  if (!installed(tx)) return null;
  const row = (
    await tx.client.query(`SELECT * FROM ${relation(tx, 'tf_follow_ups')} WHERE fired_event_id=$1`, [eventId])
  ).rows[0];
  return row ? rowSchema.parse(row) : null;
}

/** The pending follow-ups a Slack turn scheduled, as short confirmations with a Cancel button under its answer. */
export async function slackFollowUpCards(
  tx: Transaction,
  workspaceId: string,
  conversationId: string,
  turnId: string,
): Promise<SlackBlock[]> {
  if (!installed(tx)) return [];
  const rows = z.array(rowSchema).parse(
    (
      await tx.client.query(
        `SELECT f.* FROM ${relation(tx, 'tf_follow_ups')} f JOIN ${relation(tx, 'tf_slack_default_turns')} t ON t.event_id=f.slack_parent_event_id
      WHERE t.conversation_id=$1 AND t.turn_id=$2 AND f.origin_turn_id=$2 AND f.status='pending' ORDER BY f.due_at,f.id LIMIT 3`,
        [conversationId, turnId],
      )
    ).rows,
  );
  return rows.flatMap(row => followUpCard(workspaceId, row));
}

export function followUpCard(workspaceId: string, row: FollowUpRow): SlackBlock[] {
  const epoch = Math.floor(row.due_at.getTime() / 1000);
  const instruction = row.instruction.length > 280 ? `${row.instruction.slice(0, 279)}…` : row.instruction;
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:alarm_clock: Follow-up scheduled for <!date^${epoch}^{date_short_pretty} at {time}|${row.due_at.toISOString()}>`,
      },
    },
    { type: 'context', elements: [{ type: 'plain_text', text: instruction }] },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: slackFollowUpCancelAction,
          text: { type: 'plain_text', text: 'Cancel follow-up' },
          value: JSON.stringify({ workspaceId, followUpId: row.id }),
        },
      ],
    },
  ];
}

/** Best effort: tells only the person who reacted that a reminder is set, with a Cancel button. */
export async function confirmReactionFollowUp(
  token: string,
  workspaceId: string,
  row: FollowUpRow,
  user: string,
  fetcher: typeof fetch = fetch,
) {
  try {
    await fetcher('https://slack.com/api/chat.postEphemeral', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: row.slack_channel,
        user,
        ...(row.slack_thread_ts ? { thread_ts: row.slack_thread_ts } : {}),
        text: 'Reminder set for 1 hour from now. Remove the reaction to cancel it.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:alarm_clock: I'll remind you about this message in this thread in 1 hour. Remove the :${followUpReaction}: reaction or press Cancel to stop it.`,
            },
          },
          ...followUpCard(workspaceId, row).slice(2),
        ],
      }),
    });
  } catch {
    // The reminder is saved either way; a missed confirmation only hides it from the person until it runs.
  }
}
