import { type MessageContent, normalizeMessageContent } from "@tulipfarm/schema";
import type { TransactionPort } from "../ports";

/** Durable Agent-loop counters for one State occurrence, so limits survive an approval park. */
export interface LoopCheckpoint {
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly repairs: number;
  /**
   * The unfinished loop's own transcript — proposed Tool calls, their results, and the approved
   * call still owed execution. Absent once the loop settles for a reason a retry cannot fix, so
   * Tool arguments and outputs are not retained past the Turn that could still use them.
   */
  readonly resume?: LoopResumeState;
}

/**
 * Structural mirror of `AgentLoopResumeState` in `@tulipfarm/agent-runtime`, which owns the
 * meaning of every field. Restated rather than imported because storage sits below the runtime
 * in the dependency order, exactly as `LoopCheckpoint` restates the loop's counters.
 */
export interface LoopResumeState {
  readonly messages: readonly {
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly content: MessageContent;
  }[];
  readonly pendingCall?: {
    readonly callId: string;
    readonly name: string;
    readonly arguments: unknown;
  };
  readonly activeSkillName?: string;
  readonly sequence: number;
  readonly textIndex: number;
}

export const LOOP_CHECKPOINT_STORAGE_STATEMENTS: readonly string[] = [
  // Keyed by the State occurrence, not the attempt: an approval park re-enters the same
  // (business, run, state) and must reload what earlier passes already spent. Retention mirrors
  // run_budgets — one row per State occurrence, held for the life of the Run by the same FK.
  `CREATE TABLE IF NOT EXISTS agent_loop_checkpoints (
    business_id  text NOT NULL,
    run_id       uuid NOT NULL,
    state_id     text NOT NULL CHECK (length(state_id) > 0),
    iterations   bigint NOT NULL DEFAULT 0 CHECK (iterations >= 0),
    tool_calls   bigint NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
    repairs      bigint NOT NULL DEFAULT 0 CHECK (repairs >= 0),
    resume_state jsonb,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, run_id, state_id),
    FOREIGN KEY (business_id, run_id) REFERENCES runs(business_id, id)
  )`,
  // Deployments that ran the counters-only version of this table predate `resume_state`.
  `ALTER TABLE agent_loop_checkpoints ADD COLUMN IF NOT EXISTS resume_state jsonb`,
];

interface RawResumeState extends Omit<LoopResumeState, "messages"> {
  messages: readonly {
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly content: unknown;
  }[];
}

interface LoopCheckpointRow {
  iterations: string | number;
  tool_calls: string | number;
  repairs: string | number;
  resume_state: RawResumeState | null;
}

/**
 * Rows written before message content became parts hold a bare string. Normalising on read is
 * permanent, not a migration window: those rows are never rewritten.
 */
function decodeResume(raw: RawResumeState): LoopResumeState {
  return {
    ...raw,
    messages: raw.messages.map((message) => ({
      role: message.role,
      content: normalizeMessageContent(message.content),
    })),
  };
}

/**
 * Durable Agent-loop counters. The loop `save`s the same key repeatedly, so the write is an
 * idempotent, monotonic upsert: a counter only ever climbs. `GREATEST` makes a stale or racing
 * writer unable to lower a ceiling that a later pass already advanced past.
 *
 * `resume_state` is the one field that is *not* monotonic: it is the loop's live transcript, so
 * the latest writer replaces it outright and a settled loop clears it.
 */
export class RunLoopCheckpointStore {
  constructor(private readonly transactions: TransactionPort) {}

  async load(
    businessId: string,
    runId: string,
    stateId: string
  ): Promise<LoopCheckpoint | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<LoopCheckpointRow>(
        `SELECT iterations, tool_calls, repairs, resume_state
           FROM agent_loop_checkpoints
          WHERE business_id = $1 AND run_id = $2 AND state_id = $3`,
        [businessId, runId, stateId]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        businessId,
        runId,
        stateId,
        iterations: Number(row.iterations),
        toolCalls: Number(row.tool_calls),
        repairs: Number(row.repairs),
        ...(row.resume_state === null || row.resume_state === undefined
          ? {}
          : { resume: decodeResume(row.resume_state) }),
      };
    });
  }

  async save(checkpoint: LoopCheckpoint): Promise<void> {
    await this.transactions.withTransaction((transaction) =>
      transaction.query(
        `INSERT INTO agent_loop_checkpoints
           (business_id, run_id, state_id, iterations, tool_calls, repairs, resume_state,
            updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
         ON CONFLICT (business_id, run_id, state_id) DO UPDATE SET
           iterations = GREATEST(agent_loop_checkpoints.iterations, EXCLUDED.iterations),
           tool_calls = GREATEST(agent_loop_checkpoints.tool_calls, EXCLUDED.tool_calls),
           repairs = GREATEST(agent_loop_checkpoints.repairs, EXCLUDED.repairs),
           resume_state = EXCLUDED.resume_state,
           updated_at = now()`,
        [
          checkpoint.businessId,
          checkpoint.runId,
          checkpoint.stateId,
          checkpoint.iterations,
          checkpoint.toolCalls,
          checkpoint.repairs,
          checkpoint.resume === undefined ? null : JSON.stringify(checkpoint.resume),
        ]
      )
    );
  }
}
