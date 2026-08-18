/**
 * The Conversation side of a Turn, which `apps/api` owns.
 *
 * `createChatExecutor` reaches conversation state through three ports it declares itself, so this
 * app satisfies them directly rather than importing the API (`dependency-rules.md`, rule 1). What
 * is real here is the *protocol* — completion keyed by `(turnId, attempt)`, a stale attempt losing,
 * redelivery being idempotent — because that protocol is what the executor exercises and what a
 * regression in it would break. The tables behind it are the eval's own.
 */

import type { TurnCompletionRecord, TurnCompletionRef } from "@tulipfarm/turn-executor";
import type { EvalDatabase } from "./database.ts";

export interface TurnIdentity {
  readonly turnId: string;
  readonly conversationId: string;
  readonly attempt: number;
}

/** Every method the Chat executor calls on its `host`, minus Tool dispatch. */
export interface EvalTurnHost {
  findTurn(runId: string): Promise<TurnIdentity | undefined>;
  findCompletion(ref: TurnCompletionRef): Promise<TurnCompletionRecord | undefined>;
  appendAssistantMessage(
    input: TurnCompletionRef & {
      conversationId: string;
      content: string;
      metadata?: { toolCalls?: readonly unknown[] };
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
      return {
        turnId: String(row.turn_id),
        conversationId: String(row.conversation_id),
        attempt: Number(row.attempt),
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
           (id, business_id, conversation_id, turn_id, attempt, role, content, tool_calls)
         VALUES ($1, $2, $3, $4, $5, 'assistant', $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          messageId,
          input.businessId,
          input.conversationId,
          input.turnId,
          input.attempt,
          input.content,
          JSON.stringify(input.metadata?.toolCalls ?? []),
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
