/** Complete by `(turnId, attempt)`; redelivery is idempotent and stale attempts cannot win. */

import type { ParticipantToolCall } from "@tulipfarm/schema";

export type TurnCompletionStatus = "succeeded" | "failed";

export interface TurnCompletionRecord {
  readonly turnId: string;
  readonly attempt: number;
  readonly status: TurnCompletionStatus;
  readonly messageId: string | null;
}

/** `turnId` keys completion; `runId` proves the authority allowed to complete it. */
export interface TurnCompletionRef {
  readonly businessId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly attempt: number;
}

export interface TurnCompletionStore {
  findCompletion(ref: TurnCompletionRef): Promise<TurnCompletionRecord | undefined>;
  appendAssistantMessage(
    input: TurnCompletionRef & {
      conversationId: string;
      content: string;
      metadata?: { toolCalls?: readonly ParticipantToolCall[] };
    }
  ): Promise<{ messageId: string }>;
  completeTurn(
    input: TurnCompletionRef & {
      status: TurnCompletionStatus;
      cursor: number;
      messageId: string | null;
    }
  ): Promise<void>;
}

export type TurnOutcome =
  | { readonly status: "succeeded"; readonly text: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "input_required" }
  | { readonly status: "waiting"; readonly waitId: string };

export interface CompleteTurnInput {
  readonly businessId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly attempt: number;
  /** Last Run event sequence for this attempt; readers resume strictly after it. */
  readonly cursor: number;
  readonly outcome: TurnOutcome;
  readonly metadata?: { readonly toolCalls?: readonly ParticipantToolCall[] };
  /** Highest attempt the Turn has; a lower attempt arriving late is stale. */
  readonly latestAttempt?: number;
}

export type CompleteTurnResult =
  | { readonly status: "succeeded"; readonly messageId: string | null }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "waiting"; readonly waitId: string }
  | { readonly status: "stale" };

export interface ConversationTurnCompleterOptions {
  readonly store: TurnCompletionStore;
}

export class ConversationTurnCompleter {
  constructor(private readonly options: ConversationTurnCompleterOptions) {}

  /** Check before spending model/tool work; `complete` enforces the same stale-attempt rule. */
  isStale(input: Pick<CompleteTurnInput, "attempt" | "latestAttempt">): boolean {
    return input.latestAttempt !== undefined && input.latestAttempt > input.attempt;
  }

  async complete(input: CompleteTurnInput): Promise<CompleteTurnResult> {
    if (this.isStale(input)) return { status: "stale" };

    if (input.outcome.status === "waiting") {
      // The Turn is parked on a durable wait; resuming it will complete it later.
      return { status: "waiting", waitId: input.outcome.waitId };
    }

    const ref: TurnCompletionRef = {
      businessId: input.businessId,
      runId: input.runId,
      turnId: input.turnId,
      attempt: input.attempt,
    };

    const existing = await this.options.store.findCompletion(ref);
    if (existing !== undefined) {
      return existing.status === "succeeded"
        ? { status: "succeeded", messageId: existing.messageId }
        : {
            status: "failed",
            reason: input.outcome.status === "failed" ? input.outcome.reason : "",
          };
    }

    if (input.outcome.status === "failed") {
      await this.options.store.completeTurn({
        ...ref,
        status: "failed",
        cursor: input.cursor,
        messageId: null,
      });
      return { status: "failed", reason: input.outcome.reason };
    }

    if (input.outcome.status === "input_required") {
      await this.options.store.completeTurn({
        ...ref,
        status: "succeeded",
        cursor: input.cursor,
        messageId: null,
      });
      return { status: "succeeded", messageId: null };
    }

    const { messageId } = await this.options.store.appendAssistantMessage({
      ...ref,
      conversationId: input.conversationId,
      content: input.outcome.text,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
    await this.options.store.completeTurn({
      ...ref,
      status: "succeeded",
      cursor: input.cursor,
      messageId,
    });
    return { status: "succeeded", messageId };
  }
}
