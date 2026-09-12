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

export interface LoopCheckpointFence {
  readonly leaseGeneration: number;
}

export class StaleLoopCheckpointWriterError extends Error {
  constructor(runId: string, leaseGeneration: number) {
    super(`Run ${runId} is no longer owned by lease generation ${leaseGeneration}`);
    this.name = "StaleLoopCheckpointWriterError";
  }
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
  readonly retryable?: true;
  readonly retryAttempt?: number;
  readonly terminal?: {
    readonly outcome:
      | {
          readonly status: "completed";
          readonly output: unknown;
          readonly iterations: number;
          readonly toolCalls: number;
          readonly repairs: number;
        }
      | {
          readonly status: "failed";
          readonly reason:
            | "iteration_limit"
            | "tool_call_limit"
            | "repeated_tool_calls"
            | "repair_budget_exhausted"
            | "budget_exhausted"
            | "input_request_failed"
            | "handoff_unavailable"
            | "effect_after_report"
            | "model_billing_inactive"
            | "model_authentication_failed"
            | "model_not_configured"
            | "model_not_found"
            | "model_rate_limited"
            | "model_provider_unavailable"
            | "model_error"
            | "empty_model_output";
          readonly modelFailure?: { readonly requestId: string; readonly modelId?: string };
          readonly iterations: number;
          readonly toolCalls: number;
          readonly repairs: number;
          readonly maxToolCalls?: number;
        }
      | {
          readonly status: "input_required";
          readonly callId: string;
          readonly text: string;
          readonly iterations: number;
          readonly toolCalls: number;
          readonly repairs: number;
        }
      | {
          readonly status: "cancelled";
          readonly iterations: number;
          readonly toolCalls: number;
          readonly repairs: number;
        };
    readonly event: {
      readonly sequence: number;
      readonly businessId: string;
      readonly runId: string;
      readonly stateId: string;
      readonly type:
        | "iteration_started"
        | "text_delta"
        | "tool_call_dispatched"
        | "tool_call_rejected"
        | "awaiting_approval"
        | "awaiting_child"
        | "completed"
        | "failed"
        | "cancelled"
        | "skill_load_failed";
      readonly iteration: number;
      readonly toolName?: string;
      readonly callId?: string;
      readonly answeredFromCallId?: string;
      readonly outcome?: string;
      readonly text?: string;
      readonly textIndex?: number;
      readonly occurredAt: string;
    };
    readonly retryable?: true;
  };
  readonly pendingCall?: {
    readonly callId: string;
    readonly name: string;
    readonly arguments: unknown;
  };
  readonly pendingBatch?: {
    readonly calls: readonly {
      readonly callId: string;
      readonly name: string;
      readonly arguments: unknown;
    }[];
    readonly nextCallIndex: number;
  };
  readonly activeSkillName?: string;
  readonly reported?: boolean;
  readonly rereadFiles?: readonly {
    readonly fileId: string;
    readonly mediaType: string;
    readonly name: string;
  }[];
  readonly rejectionCounts?: readonly (readonly [string, number])[];
  readonly repeatCounts?: readonly (readonly [string, number])[];
  readonly cachedResults?: readonly (readonly [
    string,
    { readonly callId: string; readonly payload: Record<string, unknown> },
  ])[];
  readonly lastCallBatchSignature?: string;
  readonly consecutiveIdenticalBatches?: number;
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
 * the current lease generation replaces it outright. The Run row lock makes claim transfer and
 * checkpoint replacement one atomic order rather than two writes that can pass each other.
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

  async save(checkpoint: LoopCheckpoint, fence?: LoopCheckpointFence): Promise<void> {
    if (fence === undefined) {
      throw new StaleLoopCheckpointWriterError(checkpoint.runId, -1);
    }
    await this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ saved: number }>(
        `WITH owned_run AS MATERIALIZED (
           SELECT 1
             FROM runs
            WHERE business_id = $1
              AND id = $2
              AND lease_generation = $8
              AND status = 'running'
            FOR UPDATE
         ),
         saved AS (
           INSERT INTO agent_loop_checkpoints
             (business_id, run_id, state_id, iterations, tool_calls, repairs, resume_state,
              updated_at)
           SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, now()
             FROM owned_run
           ON CONFLICT (business_id, run_id, state_id) DO UPDATE SET
             iterations = GREATEST(agent_loop_checkpoints.iterations, EXCLUDED.iterations),
             tool_calls = GREATEST(agent_loop_checkpoints.tool_calls, EXCLUDED.tool_calls),
             repairs = GREATEST(agent_loop_checkpoints.repairs, EXCLUDED.repairs),
             resume_state = EXCLUDED.resume_state,
             updated_at = now()
           RETURNING 1 AS saved
         )
         SELECT saved FROM saved`,
        [
          checkpoint.businessId,
          checkpoint.runId,
          checkpoint.stateId,
          checkpoint.iterations,
          checkpoint.toolCalls,
          checkpoint.repairs,
          checkpoint.resume === undefined ? null : JSON.stringify(checkpoint.resume),
          fence.leaseGeneration,
        ]
      );
      if (result.rows.length === 0) {
        throw new StaleLoopCheckpointWriterError(checkpoint.runId, fence.leaseGeneration);
      }
    });
  }

  async clear(
    businessId: string,
    runId: string,
    stateId?: string,
    fence?: LoopCheckpointFence
  ): Promise<void> {
    if (fence === undefined) throw new StaleLoopCheckpointWriterError(runId, -1);
    await this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ owned: number }>(
        `WITH owned_run AS MATERIALIZED (
           SELECT 1
             FROM runs
            WHERE business_id = $1
              AND id = $2
              AND lease_generation = $4
            FOR UPDATE
         ),
         cleared AS (
           DELETE FROM agent_loop_checkpoints
            WHERE business_id = $1
              AND run_id = $2
              AND ($3::text IS NULL OR state_id = $3)
              AND EXISTS (SELECT 1 FROM owned_run)
           RETURNING 1
         )
         SELECT 1 AS owned FROM owned_run`,
        [businessId, runId, stateId ?? null, fence.leaseGeneration]
      );
      if (result.rows.length === 0) {
        throw new StaleLoopCheckpointWriterError(runId, fence.leaseGeneration);
      }
    });
  }

  async acknowledgeTerminal(
    businessId: string,
    runId: string,
    stateId: string,
    fence?: LoopCheckpointFence
  ): Promise<void> {
    if (fence === undefined) throw new StaleLoopCheckpointWriterError(runId, -1);
    await this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ owned: number }>(
        `WITH owned_run AS MATERIALIZED (
           SELECT 1
             FROM runs
            WHERE business_id = $1
              AND id = $2
              AND lease_generation = $4
              AND status = 'running'
            FOR UPDATE
         ),
         acknowledged AS (
           UPDATE agent_loop_checkpoints
              SET resume_state = jsonb_set(
                    resume_state - 'terminal',
                    '{retryAttempt}',
                    to_jsonb(COALESCE((resume_state->>'retryAttempt')::integer, 0) + 1)
                  ),
                  updated_at = now()
            WHERE business_id = $1
              AND run_id = $2
              AND state_id = $3
              AND EXISTS (SELECT 1 FROM owned_run)
              AND resume_state ? 'terminal'
           RETURNING 1
         )
         SELECT 1 AS owned FROM owned_run`,
        [businessId, runId, stateId, fence.leaseGeneration]
      );
      if (result.rows.length === 0) {
        throw new StaleLoopCheckpointWriterError(runId, fence.leaseGeneration);
      }
    });
  }

  async settle(
    businessId: string,
    runId: string,
    stateId?: string,
    fence?: LoopCheckpointFence
  ): Promise<void> {
    if (fence === undefined) throw new StaleLoopCheckpointWriterError(runId, -1);
    await this.transactions.withTransaction(async (transaction) => {
      const owned = await transaction.query(
        `SELECT 1
           FROM runs
          WHERE business_id = $1
            AND id = $2
            AND lease_generation = $3
          FOR UPDATE`,
        [businessId, runId, fence.leaseGeneration]
      );
      if (owned.rows.length === 0) {
        throw new StaleLoopCheckpointWriterError(runId, fence.leaseGeneration);
      }
      await transaction.query(
        `DELETE FROM agent_loop_checkpoints
          WHERE business_id = $1
            AND run_id = $2
            AND ($3::text IS NULL OR state_id = $3)
            AND COALESCE(resume_state->>'retryable', 'false') <> 'true'
            AND COALESCE(resume_state->'terminal'->>'retryable', 'false') <> 'true'`,
        [businessId, runId, stateId ?? null]
      );
      await transaction.query(
        `UPDATE agent_loop_checkpoints
            SET resume_state = resume_state - 'terminal',
                updated_at = now()
          WHERE business_id = $1
            AND run_id = $2
            AND ($3::text IS NULL OR state_id = $3)
            AND (
              resume_state->>'retryable' = 'true'
              OR resume_state->'terminal'->>'retryable' = 'true'
            )`,
        [businessId, runId, stateId ?? null]
      );
    });
  }
}
