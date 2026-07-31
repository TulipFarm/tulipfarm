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

/**
 * Which attempt of which Turn a write concerns.
 *
 * Both identifiers travel because they answer different questions. `turnId` names *what* is being
 * completed — completion is keyed by `(turnId, attempt)`. `runId` names the authority *under
 * which* it is completed, which is what a store that has to prove it may write at all needs: the
 * internal turn host takes the subject from the Run and refuses a Run no executor owns.
 */
export interface TurnCompletionRef {
  readonly businessId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly attempt: number;
}

export interface TurnCompletionStore {
  findCompletion(ref: TurnCompletionRef): Promise<TurnCompletionRecord | undefined>;
  appendAssistantMessage(
    input: TurnCompletionRef & { conversationId: string; content: string }
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

  /**
   * Whether a newer attempt has already superseded this one.
   *
   * Exposed so a caller can ask **before** spending a model call or landing a Tool effect, rather
   * than discovering it at completion time and throwing the work away. `complete` applies the same
   * rule, so a caller that skips the question still cannot overwrite a newer answer.
   */
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
        ? { status: "succeeded", messageId: existing.messageId ?? "" }
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

    const { messageId } = await this.options.store.appendAssistantMessage({
      ...ref,
      conversationId: input.conversationId,
      content: input.outcome.text,
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
