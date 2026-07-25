/**
 * Turn completion (SPEC §10, §18). The Run finished; this writes the durable result the reader
 * will see. Completion is keyed by `(turnId, attempt)` so a redelivered job cannot post a second
 * assistant Message, and an attempt the user already superseded by retrying is dropped as stale
 * instead of overwriting the newer one.
 */

export type TurnCompletionStatus = "succeeded" | "failed";

export interface TurnCompletionRecord {
  readonly turnId: string;
  readonly attempt: number;
  readonly status: TurnCompletionStatus;
  readonly messageId: string | null;
}

export interface TurnCompletionStore {
  findCompletion(
    businessId: string,
    turnId: string,
    attempt: number
  ): Promise<TurnCompletionRecord | undefined>;
  appendAssistantMessage(input: {
    businessId: string;
    conversationId: string;
    turnId: string;
    attempt: number;
    content: string;
  }): Promise<{ messageId: string }>;
  completeTurn(input: {
    businessId: string;
    turnId: string;
    attempt: number;
    status: TurnCompletionStatus;
    cursor: number;
    messageId: string | null;
  }): Promise<void>;
}

export type TurnOutcome =
  | { readonly status: "succeeded"; readonly text: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "waiting"; readonly waitId: string };

export interface CompleteTurnInput {
  readonly businessId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly attempt: number;
  /** Last Run event sequence for this attempt; readers resume strictly after it. */
  readonly cursor: number;
  readonly outcome: TurnOutcome;
  /** Highest attempt the Turn has; a lower attempt arriving late is stale. */
  readonly latestAttempt?: number;
}

export type CompleteTurnResult =
  | { readonly status: "succeeded"; readonly messageId: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "waiting"; readonly waitId: string }
  | { readonly status: "stale" };

export interface ConversationTurnCompleterOptions {
  readonly store: TurnCompletionStore;
}

export class ConversationTurnCompleter {
  constructor(private readonly options: ConversationTurnCompleterOptions) {}

  async complete(input: CompleteTurnInput): Promise<CompleteTurnResult> {
    if (input.latestAttempt !== undefined && input.latestAttempt > input.attempt) {
      return { status: "stale" };
    }

    if (input.outcome.status === "waiting") {
      // The Turn is parked on a durable wait; resuming it will complete it later.
      return { status: "waiting", waitId: input.outcome.waitId };
    }

    const existing = await this.options.store.findCompletion(
      input.businessId,
      input.turnId,
      input.attempt
    );
    if (existing !== undefined) {
      return existing.status === "succeeded"
        ? { status: "succeeded", messageId: existing.messageId ?? "" }
        : {
            status: "failed",
            reason: input.outcome.status === "failed" ? input.outcome.reason : "",
          };
    }

    if (input.outcome.status === "failed") {
      await this.options.store.completeTurn({
        businessId: input.businessId,
        turnId: input.turnId,
        attempt: input.attempt,
        status: "failed",
        cursor: input.cursor,
        messageId: null,
      });
      return { status: "failed", reason: input.outcome.reason };
    }

    const { messageId } = await this.options.store.appendAssistantMessage({
      businessId: input.businessId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      attempt: input.attempt,
      content: input.outcome.text,
    });
    await this.options.store.completeTurn({
      businessId: input.businessId,
      turnId: input.turnId,
      attempt: input.attempt,
      status: "succeeded",
      cursor: input.cursor,
      messageId,
    });
    return { status: "succeeded", messageId };
  }
}
