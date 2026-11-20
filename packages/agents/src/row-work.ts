import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  definitionGrantPredicate,
  lockAuthorization,
  requireTablePermission,
  resolveHuman,
  type HumanActor,
} from '@tulipfarm/access';
import { deliverComment, rowExists, wakeRow } from './row-assignments.ts';
import { relation, type AgentTransaction } from './store.ts';

const runStateSchema = z.enum(['queued', 'working', 'waiting', 'done', 'failed', 'stopped']);

export const rowThreadSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(['comment', 'progress', 'event']),
      author: z
        .discriminatedUnion('type', [
          z.object({ type: z.literal('member'), id: z.uuid() }),
          z.object({ type: z.literal('agent'), id: z.uuid() }),
        ])
        .nullable(),
      body: z.string().nullable(),
      event: z.record(z.string(), z.unknown()).nullable(),
      mentions: z.array(z.uuid()),
      createdAt: z.string(),
      editedAt: z.string().nullable(),
      deleted: z.boolean(),
      mine: z.boolean(),
    }),
  ),
  assignment: z
    .object({
      agentId: z.uuid(),
      sponsorMembershipId: z.uuid(),
      runState: runStateSchema,
      reason: z.string().nullable(),
      wakeAt: z.string().nullable(),
      canRunNow: z.boolean(),
    })
    .nullable(),
  runs: z.array(
    z.object({
      taskId: z.uuid(),
      agentId: z.uuid(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
      outcome: z.string().nullable(),
    }),
  ),
});
export type RowThread = z.infer<typeof rowThreadSchema>;

export const commentInputSchema = z.strictObject({
  body: z.string().trim().min(1).max(20000),
  mentions: z.array(z.uuid()).max(50).default([]),
});

export const inboxSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(['assigned', 'waiting', 'finished', 'mention']),
      tableId: z.uuid(),
      tableName: z.string(),
      rowId: z.uuid(),
      summary: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  open: z.number(),
});
export type Inbox = z.infer<typeof inboxSchema>;

const dailyCreditsSchema = z.number().int().min(1).max(1000000).nullable();
export const assignmentLimitsSchema = z.object({
  workspace: z.number().int().min(1).max(100),
  timeZone: z.string().min(1).max(64),
  dailyCredits: dailyCreditsSchema,
  agents: z.array(
    z.object({
      agentId: z.uuid(),
      name: z.string(),
      concurrent: z.number().int().min(1).max(20),
      dailyRuns: z.number().int().min(1).max(10000).nullable(),
      dailyCredits: dailyCreditsSchema,
    }),
  ),
});
const inboxKinds = ['assigned', 'waiting', 'finished', 'mention'] as const;
export const inboxSlackSchema = z.object({
  connected: z.boolean(),
  kinds: z.object(
    Object.fromEntries(inboxKinds.map(kind => [kind, z.boolean()])) as Record<
      (typeof inboxKinds)[number],
      z.ZodBoolean
    >,
  ),
});
export type InboxSlack = z.infer<typeof inboxSlackSchema>;
export const inboxSlackInputSchema = z.strictObject({ kinds: inboxSlackSchema.shape.kinds.strict() });

/** What admins send. Fields left out keep their saved values, so an older web app can't clear the newer caps. */
export const assignmentLimitsInputSchema = z.strictObject({
  workspace: assignmentLimitsSchema.shape.workspace,
  timeZone: assignmentLimitsSchema.shape.timeZone.optional(),
  dailyCredits: dailyCreditsSchema.optional(),
  agents: z
    .array(
      z.strictObject({
        agentId: z.uuid(),
        concurrent: z.number().int().min(1).max(20),
        dailyRuns: z.number().int().min(1).max(10000).nullable(),
        dailyCredits: dailyCreditsSchema.optional(),
      }),
    )
    .max(500),
});
export type AssignmentLimits = z.infer<typeof assignmentLimitsSchema>;

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

async function requireRow(tx: AgentTransaction, actor: HumanActor, tableId: string, rowId: string) {
  await requireTablePermission(tx, actor, tableId, 'table.row.read');
  if (!(await rowExists(tx, tableId, rowId))) throw new AccessDenied();
}

async function mayInvoke(tx: AgentTransaction, actor: HumanActor, agentId: string) {
  return Boolean(
    (
      await tx.client.query(
        `SELECT ${definitionGrantPredicate(tx, 'agent', '$2::uuid', '$1::uuid', "'invoke'")} AS allowed`,
        [actor.membershipId, agentId],
      )
    ).rows[0]?.allowed,
  );
}

async function canEditRow(tx: AgentTransaction, actor: HumanActor, tableId: string) {
  return requireTablePermission(tx, actor, tableId, 'table.row.update').then(
    () => true,
    error => {
      if (error instanceof AccessDenied) return false;
      throw error;
    },
  );
}

async function readThread(tx: AgentTransaction, actor: HumanActor, tableId: string, rowId: string): Promise<RowThread> {
  const items = (
    await tx.client.query(
      `SELECT * FROM ${relation(tx, 'tf_row_thread_items')} WHERE table_id=$1 AND row_id=$2 ORDER BY created_at,id LIMIT 500`,
      [tableId, rowId],
    )
  ).rows.map(row => ({
    id: row.id,
    kind: row.kind,
    author: row.author_membership_id
      ? { type: 'member' as const, id: row.author_membership_id }
      : row.author_agent_id
        ? { type: 'agent' as const, id: row.author_agent_id }
        : null,
    body: row.deleted_at ? null : row.body,
    event: row.event,
    mentions: row.deleted_at ? [] : row.mentions,
    createdAt: iso(row.created_at),
    editedAt: row.edited_at ? iso(row.edited_at) : null,
    deleted: Boolean(row.deleted_at),
    mine: row.author_membership_id === actor.membershipId,
  }));
  const assignment = (
    await tx.client.query(`SELECT * FROM ${relation(tx, 'tf_row_assignments')} WHERE table_id=$1 AND row_id=$2`, [
      tableId,
      rowId,
    ])
  ).rows[0];
  const runs = (
    await tx.client.query(
      `SELECT * FROM ${relation(tx, 'tf_row_assignment_runs')} WHERE table_id=$1 AND row_id=$2 ORDER BY started_at DESC LIMIT 20`,
      [tableId, rowId],
    )
  ).rows.map(run => ({
    taskId: run.task_id,
    agentId: run.agent_id,
    startedAt: iso(run.started_at),
    endedAt: run.ended_at ? iso(run.ended_at) : null,
    outcome: run.outcome,
  }));
  return rowThreadSchema.parse({
    items,
    assignment:
      assignment && assignment.run_state !== 'stopped'
        ? {
            agentId: assignment.agent_id,
            sponsorMembershipId: assignment.sponsor_membership_id,
            runState: assignment.run_state,
            reason: assignment.reason,
            wakeAt: assignment.wake_at ? iso(assignment.wake_at) : null,
            canRunNow: (await canEditRow(tx, actor, tableId)) && (await mayInvoke(tx, actor, assignment.agent_id)),
          }
        : null,
    runs,
  });
}

/** Mentioned members who can read the row get an Inbox item; others are dropped silently. */
async function notifyMentions(
  tx: AgentTransaction,
  actor: HumanActor,
  tableId: string,
  rowId: string,
  itemId: string,
  mentions: readonly string[],
) {
  const members = (
    await tx.client.query(
      `SELECT id,user_id FROM ${relation(tx, 'tf_memberships')} WHERE id=ANY($1::uuid[]) AND removed_at IS NULL AND id<>$2`,
      [mentions, actor.membershipId],
    )
  ).rows;
  for (const member of members) {
    const reader: HumanActor = { kind: 'human', userId: member.user_id, membershipId: member.id };
    const readable = await requireTablePermission(tx, reader, tableId, 'table.row.read').then(
      () => true,
      () => false,
    );
    if (!readable) continue;
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_inbox_items')}(id,membership_id,kind,table_id,row_id,source_id,summary) VALUES($1,$2,'mention',$3,$4,$5,'You were mentioned in a comment') ON CONFLICT DO NOTHING`,
      [randomUUID(), member.id, tableId, rowId, itemId],
    );
  }
}

type Runtime = {
  transaction<T>(
    workspaceId: string,
    compatibility: unknown,
    operation: (tx: AgentTransaction) => Promise<T>,
  ): Promise<T>;
};

/** Row threads, Run now, the Inbox and assignment limits: what people do around assigned rows. */
export function createRowWork(runtime: Runtime, compatibility: unknown) {
  const as = <T>(
    workspaceId: string,
    userId: string,
    operation: (tx: AgentTransaction, actor: HumanActor) => Promise<T>,
  ) =>
    runtime.transaction(z.uuid().parse(workspaceId), compatibility, async tx => {
      await lockAuthorization(tx);
      return operation(tx, await resolveHuman(tx, userId));
    });

  async function ownComment(tx: AgentTransaction, actor: HumanActor, tableId: string, rowId: string, itemId: string) {
    await requireRow(tx, actor, tableId, rowId);
    const item = (
      await tx.client.query(
        `SELECT * FROM ${relation(tx, 'tf_row_thread_items')} WHERE id=$1 AND table_id=$2 AND row_id=$3 FOR UPDATE`,
        [itemId, tableId, rowId],
      )
    ).rows[0];
    if (!item || item.kind !== 'comment' || item.author_membership_id !== actor.membershipId || item.deleted_at)
      throw new AccessDenied();
    return item;
  }

  return {
    thread: (workspaceId: string, userId: string, tableId: string, rowId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        await requireRow(tx, actor, tableId, rowId);
        return readThread(tx, actor, tableId, rowId);
      }),

    comment: (workspaceId: string, userId: string, tableId: string, rowId: string, value: unknown) =>
      as(workspaceId, userId, async (tx, actor) => {
        const input = commentInputSchema.parse(value);
        await requireRow(tx, actor, tableId, rowId);
        const id = randomUUID();
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_row_thread_items')}(id,table_id,row_id,kind,author_membership_id,body,mentions) VALUES($1,$2,$3,'comment',$4,$5,$6)`,
          [id, tableId, rowId, actor.membershipId, input.body, input.mentions],
        );
        await notifyMentions(tx, actor, tableId, rowId, id, input.mentions);
        await deliverComment(tx, tableId, rowId, actor.membershipId, input.body);
        return readThread(tx, actor, tableId, rowId);
      }),

    editComment: (
      workspaceId: string,
      userId: string,
      tableId: string,
      rowId: string,
      itemId: string,
      value: unknown,
    ) =>
      as(workspaceId, userId, async (tx, actor) => {
        const input = commentInputSchema.parse(value);
        await ownComment(tx, actor, tableId, rowId, itemId);
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_row_thread_items')} SET body=$2,mentions=$3,edited_at=clock_timestamp() WHERE id=$1`,
          [itemId, input.body, input.mentions],
        );
        await notifyMentions(tx, actor, tableId, rowId, itemId, input.mentions);
        return readThread(tx, actor, tableId, rowId);
      }),

    deleteComment: (workspaceId: string, userId: string, tableId: string, rowId: string, itemId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        await ownComment(tx, actor, tableId, rowId, itemId);
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_row_thread_items')} SET body=NULL,mentions='{}',deleted_at=clock_timestamp() WHERE id=$1`,
          [itemId],
        );
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_inbox_items')} SET resolved_at=clock_timestamp() WHERE kind='mention' AND source_id=$1 AND resolved_at IS NULL`,
          [itemId],
        );
        return readThread(tx, actor, tableId, rowId);
      }),

    runNow: (workspaceId: string, userId: string, tableId: string, rowId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        await requireRow(tx, actor, tableId, rowId);
        const assignment = (
          await tx.client.query(
            `SELECT agent_id FROM ${relation(tx, 'tf_row_assignments')} WHERE table_id=$1 AND row_id=$2 AND run_state<>'stopped' FOR UPDATE`,
            [tableId, rowId],
          )
        ).rows[0];
        if (!assignment) throw new AccessDenied();
        await requireTablePermission(tx, actor, tableId, 'table.row.update');
        if (!(await mayInvoke(tx, actor, assignment.agent_id))) throw new AccessDenied();
        await wakeRow(tx, tableId, rowId, actor.membershipId);
        return readThread(tx, actor, tableId, rowId);
      }),

    clearWake: (workspaceId: string, userId: string, tableId: string, rowId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        await requireRow(tx, actor, tableId, rowId);
        await requireTablePermission(tx, actor, tableId, 'table.row.update');
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_row_assignments')} SET wake_at=NULL,updated_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2`,
          [tableId, rowId],
        );
        return readThread(tx, actor, tableId, rowId);
      }),

    inbox: (workspaceId: string, userId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        const rows = (
          await tx.client.query(
            `SELECT i.*,COALESCE(g.definition->>'label',c.display_name) AS table_name FROM ${relation(tx, 'tf_inbox_items')} i
            JOIN ${relation(tx, 'tf_table_catalog')} c ON c.id=i.table_id AND c.archived_at IS NULL
            LEFT JOIN ${relation(tx, 'tf_table_generations')} g ON g.table_id=i.table_id AND g.state='active'
            WHERE i.membership_id=$1 AND i.done_at IS NULL AND i.resolved_at IS NULL
            ORDER BY i.created_at DESC,i.id LIMIT 200`,
            [actor.membershipId],
          )
        ).rows;
        const items = [];
        for (const row of rows) {
          // Behavior 60: never show an item for a row the member can no longer read.
          const readable = await requireRow(tx, actor, row.table_id, row.row_id).then(
            () => true,
            () => false,
          );
          if (!readable) continue;
          items.push({
            id: row.id,
            kind: row.kind,
            tableId: row.table_id,
            tableName: row.table_name,
            rowId: row.row_id,
            summary: row.summary,
            createdAt: iso(row.created_at),
          });
        }
        return inboxSchema.parse({ items, open: items.length });
      }),

    markDone: (workspaceId: string, userId: string, itemId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        const changed = await tx.client.query(
          `UPDATE ${relation(tx, 'tf_inbox_items')} SET done_at=clock_timestamp() WHERE id=$1 AND membership_id=$2 AND done_at IS NULL`,
          [z.uuid().parse(itemId), actor.membershipId],
        );
        if (!changed.rowCount) throw new AccessDenied();
      }),

    slackPreferences: (workspaceId: string, userId: string) =>
      as(workspaceId, userId, (tx, actor) => readSlackPreferences(tx, actor.membershipId)),

    setSlackPreferences: (workspaceId: string, userId: string, value: unknown) =>
      as(workspaceId, userId, async (tx, actor) => {
        const { kinds } = inboxSlackInputSchema.parse(value);
        await tx.client.query(`DELETE FROM ${relation(tx, 'tf_inbox_slack_muted')} WHERE membership_id=$1`, [
          actor.membershipId,
        ]);
        const muted = inboxKinds.filter(kind => !kinds[kind]);
        if (muted.length)
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_inbox_slack_muted')}(membership_id,kind) SELECT $1,unnest($2::text[])`,
            [actor.membershipId, muted],
          );
        return readSlackPreferences(tx, actor.membershipId);
      }),

    limits: (workspaceId: string, userId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        if ((await currentMember(tx, actor)).role !== 'admin') throw new AccessDenied();
        return readLimits(tx);
      }),

    setLimits: (workspaceId: string, userId: string, value: unknown) =>
      as(workspaceId, userId, async (tx, actor) => {
        if ((await currentMember(tx, actor)).role !== 'admin') throw new AccessDenied();
        const input = assignmentLimitsInputSchema.parse(value);
        if (
          input.timeZone !== undefined &&
          !(await tx.client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1', [input.timeZone])).rowCount
        )
          throw new AssignmentLimitsError('unknown-time-zone');
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_workspace_assignment_limits')}(singleton,concurrent,time_zone,daily_credits) VALUES(true,$1,COALESCE($2,'UTC'),$3)
          ON CONFLICT (singleton) DO UPDATE SET concurrent=EXCLUDED.concurrent,
            time_zone=COALESCE($2,${relation(tx, 'tf_workspace_assignment_limits')}.time_zone),
            daily_credits=CASE WHEN $4 THEN EXCLUDED.daily_credits ELSE ${relation(tx, 'tf_workspace_assignment_limits')}.daily_credits END`,
          [input.workspace, input.timeZone ?? null, input.dailyCredits ?? null, input.dailyCredits !== undefined],
        );
        for (const agent of input.agents)
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_agent_assignment_limits')}(agent_id,concurrent,daily_runs,daily_credits)
            SELECT id,$2,$3,$4 FROM ${relation(tx, 'tf_agents')} WHERE id=$1
            ON CONFLICT (agent_id) DO UPDATE SET concurrent=EXCLUDED.concurrent,daily_runs=EXCLUDED.daily_runs,
              daily_credits=CASE WHEN $5 THEN EXCLUDED.daily_credits ELSE ${relation(tx, 'tf_agent_assignment_limits')}.daily_credits END`,
            [
              agent.agentId,
              agent.concurrent,
              agent.dailyRuns,
              agent.dailyCredits ?? null,
              agent.dailyCredits !== undefined,
            ],
          );
        return readLimits(tx);
      }),
  };
}

async function readLimits(tx: AgentTransaction): Promise<AssignmentLimits> {
  const workspace = (
    await tx.client.query(
      `SELECT concurrent,time_zone AS "timeZone",daily_credits AS "dailyCredits" FROM ${relation(tx, 'tf_workspace_assignment_limits')}`,
    )
  ).rows[0];
  const agents = (
    await tx.client.query(
      `SELECT a.id AS "agentId",a.display_name AS name,COALESCE(l.concurrent,3) AS concurrent,l.daily_runs AS "dailyRuns",
        l.daily_credits AS "dailyCredits"
      FROM ${relation(tx, 'tf_agents')} a LEFT JOIN ${relation(tx, 'tf_agent_assignment_limits')} l ON l.agent_id=a.id
      WHERE a.saved_revision IS NOT NULL AND a.deleted_at IS NULL ORDER BY lower(a.display_name),a.id`,
    )
  ).rows;
  return assignmentLimitsSchema.parse({
    workspace: workspace?.concurrent ?? 10,
    timeZone: workspace?.timeZone ?? 'UTC',
    dailyCredits: workspace?.dailyCredits ?? null,
    agents,
  });
}

async function readSlackPreferences(tx: AgentTransaction, membershipId: string): Promise<InboxSlack> {
  const muted = new Set(
    (
      await tx.client.query(`SELECT kind FROM ${relation(tx, 'tf_inbox_slack_muted')} WHERE membership_id=$1`, [
        membershipId,
      ])
    ).rows.map(row => String(row.kind)),
  );
  const connected = Boolean(
    (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_slack_identities')} i JOIN ${relation(tx, 'tf_slack_installations')} s
          ON s.id=i.installation_id AND s.generation=i.generation AND s.state='active'
        WHERE i.membership_id=$1 AND i.state<>'revoked'`,
        [membershipId],
      )
    ).rowCount,
  );
  return inboxSlackSchema.parse({
    connected,
    kinds: Object.fromEntries(inboxKinds.map(kind => [kind, !muted.has(kind)])),
  });
}

export class AssignmentLimitsError extends Error {
  constructor(readonly code: 'unknown-time-zone') {
    super(code);
    this.name = 'AssignmentLimitsError';
  }
}
