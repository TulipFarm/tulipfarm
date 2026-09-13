/**
 * The Conversation side of a Turn, which `apps/api` owns.
 *
 * `createChatExecutor` reaches conversation state through three ports it declares itself, so this
 * app satisfies them directly rather than importing the API (`dependency-rules.md`, rule 1). What
 * is real here is the *protocol* — completion keyed by `(turnId, attempt)`, a stale attempt losing,
 * redelivery being idempotent — because that protocol is what the executor exercises and what a
 * regression in it would break. The tables behind it are the eval's own.
 */

import { contentText, normalizeMessageContent, textContent } from "@tulipfarm/schema";
import type {
  TurnAttemptHistory,
  TurnCompletionRecord,
  TurnCompletionRef,
} from "@tulipfarm/turn-executor";
import type { EvalDatabase } from "./database.ts";

export interface TurnIdentity {
  readonly turnId: string;
  readonly conversationId: string;
  readonly attempt: number;
  readonly history?: TurnAttemptHistory;
}

/** Every method the Chat executor calls on its `host`, minus Tool dispatch. */
export interface EvalTurnHost {
  findTurn(runId: string): Promise<TurnIdentity | undefined>;
  findCompletion(ref: TurnCompletionRef): Promise<TurnCompletionRecord | undefined>;
  appendAssistantMessage(
    input: TurnCompletionRef & {
      conversationId: string;
      content: string;
      metadata?: Readonly<Record<string, unknown>> & { toolCalls?: readonly unknown[] };
    }
  ): Promise<{ messageId: string }>;
  completeTurn(
    input: TurnCompletionRef & {
      status: "succeeded" | "failed";
      cursor: number;
      messageId: string | null;
    }
  ): Promise<void>;
}

export function evalTurnHost(database: EvalDatabase): EvalTurnHost {
  return {
    async findTurn(runId) {
      const { rows } = await database.query(
        "SELECT turn_id, conversation_id, attempt FROM eval_turns WHERE run_id = $1",
        [runId]
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      const message = await database.query(
        `SELECT content, metadata FROM eval_messages
          WHERE turn_id = $1 AND attempt = $2 AND role = 'assistant'
          ORDER BY seq DESC LIMIT 1`,
        [row.turn_id, row.attempt]
      );
      const history = restoredHistory(message.rows[0]);
      return {
        turnId: String(row.turn_id),
        conversationId: String(row.conversation_id),
        attempt: Number(row.attempt),
        ...(history === undefined ? {} : { history }),
      };
    },

    async findCompletion(ref) {
      const { rows } = await database.query(
        `SELECT turn_id, attempt, status, message_id FROM eval_turns
          WHERE business_id = $1 AND turn_id = $2 AND attempt = $3 AND status IS NOT NULL`,
        [ref.businessId, ref.turnId, ref.attempt]
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      const status = String(row.status);
      // A row whose status is neither terminal is not a completion. Coercing it into one would let
      // a half-finished Turn read as answered and the executor would decline to finish it.
      if (status !== "succeeded" && status !== "failed") return undefined;
      return {
        turnId: String(row.turn_id),
        attempt: Number(row.attempt),
        status,
        messageId: row.message_id === null ? null : String(row.message_id),
      };
    },

    async appendAssistantMessage(input) {
      const messageId = `msg-${input.turnId}-${input.attempt}`;
      await database.query(
        `INSERT INTO eval_messages
           (id, business_id, conversation_id, turn_id, attempt, role, content, tool_calls, metadata)
         VALUES ($1, $2, $3, $4, $5, 'assistant', $6, $7, $8)
           ON CONFLICT (id) DO UPDATE
             SET content = EXCLUDED.content,
                 tool_calls = EXCLUDED.tool_calls,
                 metadata = EXCLUDED.metadata`,
        [
          messageId,
          input.businessId,
          input.conversationId,
          input.turnId,
          input.attempt,
          JSON.stringify(textContent(input.content)),
          JSON.stringify(input.metadata?.toolCalls ?? []),
          JSON.stringify(input.metadata ?? {}),
        ]
      );
      return { messageId };
    },

    async completeTurn(input) {
      // Only from an uncompleted row: a redelivered attempt must not overwrite the verdict already
      // recorded, and a stale attempt must not overwrite a newer one's.
      await database.query(
        `UPDATE eval_turns
            SET status = $4, cursor = $5, message_id = $6
          WHERE business_id = $1 AND turn_id = $2 AND attempt = $3 AND status IS NULL`,
        [input.businessId, input.turnId, input.attempt, input.status, input.cursor, input.messageId]
      );
    },
  };
}

function restoredHistory(row: Record<string, unknown> | undefined): TurnAttemptHistory | undefined {
  if (row === undefined) return undefined;
  const metadata =
    typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata ?? {});
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
    return undefined;
  const value = metadata as Record<string, unknown>;
  const attempt = value.turnAttempt;
  if (typeof attempt !== "object" || attempt === null || Array.isArray(attempt)) return undefined;
  const turnAttempt = attempt as Record<string, unknown>;
  if (
    typeof turnAttempt.cursor !== "number" ||
    typeof turnAttempt.outcome !== "string" ||
    typeof turnAttempt.complete !== "boolean"
  ) {
    return undefined;
  }
  const outcome = turnAttempt.outcome;
  if (
    outcome !== "active" &&
    outcome !== "waiting" &&
    outcome !== "succeeded" &&
    outcome !== "failed" &&
    outcome !== "cancelled"
  ) {
    return undefined;
  }
  return {
    text: contentText(normalizeMessageContent(JSON.parse(String(row.content)))),
    toolCalls: Array.isArray(value.toolCalls)
      ? (value.toolCalls as TurnAttemptHistory["toolCalls"])
      : [],
    surfaces: Array.isArray(value.surfaces)
      ? (value.surfaces as TurnAttemptHistory["surfaces"])
      : [],
    ...(Array.isArray(value.events)
      ? { events: value.events as NonNullable<TurnAttemptHistory["events"]> }
      : {}),
    ...(typeof value.receipt === "object" && value.receipt !== null
      ? { receipt: value.receipt as NonNullable<TurnAttemptHistory["receipt"]> }
      : {}),
    cursor: turnAttempt.cursor,
    outcome,
    complete: turnAttempt.complete,
    ...(typeof turnAttempt.wait === "object" && turnAttempt.wait !== null
      ? { wait: turnAttempt.wait as NonNullable<TurnAttemptHistory["wait"]> }
      : {}),
  };
}
