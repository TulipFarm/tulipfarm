import { z } from 'zod';
import { AccessDenied, currentMember, lockAuthorization, uuidSchema, type HumanActor } from '@tulipfarm/access';
import { commonCompatibility, qualified, type SqlClient } from '@tulipfarm/workspace-storage/runtime';
import {
  CODING_RUN_APPROVAL_MS,
  codingAgents,
  codingRunDecisionSchema,
  type CodingAgent,
  type CodingRunStatus,
  type CodingRunView,
} from './coding-run-contracts.ts';

export type CodingRunTransaction = { client: SqlClient; schema: string };
export type CodingRunStorage = {
  transaction<T>(
    workspaceId: string,
    range: { minimum: number; maximum: number },
    action: (tx: CodingRunTransaction) => Promise<T>,
  ): Promise<T>;
};

/** The exact run a member approves, as it is stored. */
export type CodingRunRecord = {
  id: string;
  actor: HumanActor;
  conversationId: string;
  turnId: string;
  generation: number;
  agent: CodingAgent;
  repository: string;
  branch: string | null;
  task: string;
  planOwnerMembershipId: string;
  digest: string;
};
export type CodingRunOrigin = { conversationId: string; turnId: string; generation: number };

/** Time past the run's own limit before a run whose worker vanished is called interrupted. */
const runningGraceMs = 5 * 60 * 1000;

const runTable = (tx: CodingRunTransaction) => qualified(tx.schema, 'tf_coding_runs');

const rowSchema = z.object({
  id: uuidSchema,
  membership_id: uuidSchema,
  user_id: z.string(),
  conversation_id: uuidSchema,
  turn_id: uuidSchema,
  generation: z.number().int(),
  agent: z.enum(codingAgents),
  repository: z.string(),
  branch: z.string().nullable(),
  task: z.string(),
  plan_owner_membership_id: uuidSchema,
  digest: z.string(),
  decision: z.enum(['pending', 'approved', 'denied']),
  decision_command_id: uuidSchema.nullable(),
  status: z.enum(['waiting', 'expired', 'running', 'finished', 'interrupted']),
  expires_at: z.date(),
  result: z.unknown().nullable(),
  expired: z.boolean(),
  overdue: z.boolean(),
});
type Row = z.infer<typeof rowSchema>;

async function loadRow(tx: CodingRunTransaction, id: string): Promise<Row | undefined> {
  return rowSchema.optional().parse(
    (
      await tx.client.query(
        `SELECT id, membership_id, user_id, conversation_id, turn_id, generation, agent, repository, branch, task,
           plan_owner_membership_id, digest, decision, decision_command_id, status, expires_at, result,
           expires_at <= clock_timestamp() AS expired,
           COALESCE(deadline_at <= clock_timestamp(), false) AS overdue
         FROM ${runTable(tx)} WHERE id = $1`,
        [id],
      )
    ).rows[0],
  );
}

const recordOf = (row: Row): CodingRunRecord => ({
  id: row.id,
  actor: { kind: 'human', userId: row.user_id, membershipId: row.membership_id },
  conversationId: row.conversation_id,
  turnId: row.turn_id,
  generation: row.generation,
  agent: row.agent,
  repository: row.repository,
  branch: row.branch,
  task: row.task,
  planOwnerMembershipId: row.plan_owner_membership_id,
  digest: row.digest,
});
const originOf = (row: Row): CodingRunOrigin => ({
  conversationId: row.conversation_id,
  turnId: row.turn_id,
  generation: row.generation,
});

function statusOf(row: Row): CodingRunStatus {
  if (row.status !== 'waiting') return row.status;
  if (row.decision === 'denied') return 'denied';
  if (row.decision === 'approved') return 'approved';
  return row.expired ? 'expired' : 'awaiting-approval';
}
const outcomeOf = (row: Row) => z.object({ status: z.string() }).safeParse(row.result).data?.status ?? null;

function viewOf(row: Row): CodingRunView {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    agent: row.agent,
    repository: row.repository,
    branch: row.branch,
    task: row.task,
    digest: row.digest,
    ownPlan: row.plan_owner_membership_id === row.membership_id,
    status: statusOf(row),
    expiresAt: row.expires_at.toISOString(),
    outcome: outcomeOf(row),
  };
}

/** Records a run for its member's decision. Proposing the same call again changes nothing. */
export async function proposeCodingRun(storage: CodingRunStorage, workspaceId: string, run: CodingRunRecord) {
  await storage.transaction(workspaceId, commonCompatibility, tx =>
    tx.client.query(
      `INSERT INTO ${runTable(tx)} (id, membership_id, user_id, conversation_id, turn_id, generation, agent, repository, branch, task, plan_owner_membership_id, digest, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, clock_timestamp() + $13 * interval '1 millisecond')
       ON CONFLICT (id) DO NOTHING`,
      [
        run.id,
        run.actor.membershipId,
        run.actor.userId,
        run.conversationId,
        run.turnId,
        run.generation,
        run.agent,
        run.repository,
        run.branch,
        run.task,
        run.planOwnerMembershipId,
        run.digest,
        CODING_RUN_APPROVAL_MS,
      ],
    ),
  );
}

/** The member's own run. Anyone else reads `undefined`. */
export async function viewCodingRun(tx: CodingRunTransaction, actor: HumanActor, runId: string) {
  const row = await loadRow(tx, z.uuid().parse(runId));
  return row && row.membership_id === actor.membershipId ? viewOf(row) : undefined;
}

export class CodingRunDecisionConflict extends Error {
  constructor() {
    super('coding-run-conflict');
    this.name = 'CodingRunDecisionConflict';
  }
}

/**
 * Records the member's decision on their own waiting run, in a transaction of the confirmation role. A retry of the
 * same command returns the run again; any other second decision, a stale digest, an expired run or a chat turn that
 * stopped waiting is a conflict.
 */
export async function decideCodingRun(
  tx: CodingRunTransaction,
  actor: HumanActor,
  runId: string,
  input: unknown,
): Promise<{ view: CodingRunView; origin: CodingRunOrigin }> {
  const decision = codingRunDecisionSchema.parse(input);
  const stored = decision.decision === 'approve' ? 'approved' : 'denied';
  await lockAuthorization(tx);
  await currentMember(tx, actor);
  const id = z.uuid().parse(runId);
  const row = await loadRow(tx, id);
  if (!row || row.membership_id !== actor.membershipId) throw new AccessDenied();
  const replay = (current: Row) => {
    if (current.decision_command_id !== decision.commandId || current.decision !== stored) return undefined;
    return { view: viewOf(current), origin: originOf(current) };
  };
  if (row.decision !== 'pending') {
    const earlier = replay(row);
    if (!earlier) throw new CodingRunDecisionConflict();
    return earlier;
  }
  if (row.status !== 'waiting' || row.expired || row.digest !== decision.digest) throw new CodingRunDecisionConflict();
  const live = await tx.client.query(
    `SELECT 1 FROM ${qualified(tx.schema, 'tf_conversation_turns')} WHERE id=$1 AND generation=$2 AND status='waiting'`,
    [row.turn_id, row.generation],
  );
  if (!live.rowCount) throw new CodingRunDecisionConflict();
  await tx.client.query(
    `UPDATE ${runTable(tx)} SET decision=$2, decision_command_id=$3, decided_at=clock_timestamp()
     WHERE id=$1 AND decision='pending' AND status='waiting' AND expires_at > clock_timestamp()`,
    [id, stored, decision.commandId],
  );
  const decided = await loadRow(tx, id);
  const result = decided && replay(decided);
  if (!result) throw new CodingRunDecisionConflict();
  return result;
}

export type CodingRunEnd = { status: string; [key: string]: unknown };

const endings = {
  denied: "The person chose not to run this. Nothing ran. Don't run it again unless they ask.",
  expired: 'Nobody approved this run within 24 hours, so it expired. Nothing ran.',
  interrupted:
    'The run stopped before it finished, so there is no result. Nothing was pushed. Ask the person before running it again.',
} as const;
const ended = (status: keyof typeof endings) => ({
  state: 'done' as const,
  result: { status, message: endings[status] },
});

/**
 * Continues a run after its member's decision. An approved run is started once through `start`, which must be
 * idempotent; `waiting` means it is undecided or still running.
 */
export async function resumeCodingRun(
  storage: CodingRunStorage,
  workspaceId: string,
  runId: string,
  start: () => Promise<void>,
): Promise<{ state: 'waiting' } | { state: 'done'; result: CodingRunEnd }> {
  const settle = async (status: 'expired' | 'interrupted', from: Row['status']) => {
    await storage.transaction(workspaceId, commonCompatibility, tx =>
      tx.client.query(
        `UPDATE ${runTable(tx)} SET status=$2, finished_at=CASE WHEN $2='interrupted' THEN clock_timestamp() END WHERE id=$1 AND status=$3`,
        [runId, status, from],
      ),
    );
    return resumeCodingRun(storage, workspaceId, runId, start);
  };
  const row = await storage.transaction(workspaceId, commonCompatibility, tx => loadRow(tx, runId));
  if (!row) throw new AccessDenied();
  switch (row.status) {
    case 'finished':
      return { state: 'done', result: z.object({ status: z.string() }).loose().parse(row.result) };
    case 'expired':
    case 'interrupted':
      return ended(row.status);
    case 'running':
      return row.overdue ? settle('interrupted', 'running') : { state: 'waiting' };
  }
  if (row.decision === 'denied') return ended('denied');
  if (row.decision === 'pending') return row.expired ? settle('expired', 'waiting') : { state: 'waiting' };
  await start();
  return { state: 'waiting' };
}

/**
 * Runs an approved run once: claims it, runs `execute` and stores its result, then wakes the chat waiting on it.
 * A run claimed before, or not approved, is left alone.
 */
export async function runApprovedCodingRun(
  storage: CodingRunStorage,
  workspaceId: string,
  runId: string,
  limitMs: number,
  execute: (run: CodingRunRecord) => Promise<Record<string, unknown>>,
) {
  const claimed = await storage.transaction(workspaceId, commonCompatibility, async tx => {
    const updated = await tx.client.query(
      `UPDATE ${runTable(tx)} SET status='running', started_at=clock_timestamp(), deadline_at=clock_timestamp() + $2 * interval '1 millisecond'
       WHERE id=$1 AND status='waiting' AND decision='approved'`,
      [runId, limitMs + runningGraceMs],
    );
    return updated.rowCount ? loadRow(tx, runId) : undefined;
  });
  if (!claimed) return false;
  let result: Record<string, unknown> | undefined;
  try {
    result = await execute(recordOf(claimed));
  } finally {
    await storage.transaction(workspaceId, commonCompatibility, async tx => {
      await tx.client.query(
        result
          ? `UPDATE ${runTable(tx)} SET status='finished', finished_at=clock_timestamp(), result=$2 WHERE id=$1 AND status='running'`
          : `UPDATE ${runTable(tx)} SET status='interrupted', finished_at=clock_timestamp() WHERE id=$1 AND status='running'`,
        result ? [runId, JSON.stringify(result)] : [runId],
      );
      await wakeCodingRunChat(tx, originOf(claimed));
    });
  }
  return true;
}

/** Marks a run whose worker stopped as interrupted, so its chat continues without waiting for the deadline. */
export async function interruptCodingRun(storage: CodingRunStorage, workspaceId: string, runId: string) {
  await storage.transaction(workspaceId, commonCompatibility, async tx => {
    const row = await loadRow(tx, runId);
    if (!row || row.status !== 'running') return;
    await tx.client.query(
      `UPDATE ${runTable(tx)} SET status='interrupted', finished_at=clock_timestamp() WHERE id=$1 AND status='running'`,
      [runId],
    );
    await wakeCodingRunChat(tx, originOf(row));
  });
}

async function wakeCodingRunChat(tx: CodingRunTransaction, origin: CodingRunOrigin) {
  await tx.client.query(
    `UPDATE ${qualified(tx.schema, 'tf_conversation_outbox')} SET next_attempt_at=clock_timestamp() WHERE turn_id=$1 AND generation=$2`,
    [origin.turnId, origin.generation],
  );
}
