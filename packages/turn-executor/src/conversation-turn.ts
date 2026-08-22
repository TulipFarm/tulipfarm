/** Complete by `(turnId, attempt)`; redelivery is idempotent and stale attempts cannot win. */

import type { ModelFailureDiagnostic } from "@tulipfarm/agent-runtime";
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
  /**
   * Records the outcome, and links any Surfaces the attempt presented.
   *
   * The Surfaces ride with completion rather than on a call of their own so that the link and the
   * outcome land together: the Artifact is already durable, but the fact that *this* Conversation
   * was shown it is not, and a crash between two writes would either lose the cards or duplicate
   * them on redelivery.
   */
  completeTurn(
    input: TurnCompletionRef & {
      status: TurnCompletionStatus;
      cursor: number;
      messageId: string | null;
      conversationId?: string;
      surfaces?: readonly TurnSurfaceLink[];
    }
  ): Promise<void>;
}

export interface TurnSurfaceLink {
  readonly artifactId: string;
  readonly revision: number;
}

export type TurnOutcome =
  | { readonly status: "succeeded"; readonly text: string }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly modelFailure?: ModelFailureDiagnostic;
    }
  | { readonly status: "input_required"; readonly text: string }
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
  /** Surfaces this Turn presented, linked into the transcript so a refresh can restore them. */
  readonly surfaces?: readonly TurnSurfaceLink[];
  /** Highest attempt the Turn has; a lower attempt arriving late is stale. */
  readonly latestAttempt?: number;
}

export type CompleteTurnResult =
  | { readonly status: "succeeded"; readonly messageId: string | null }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly modelFailure?: ModelFailureDiagnostic;
    }
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
            ...(input.outcome.status === "failed" && input.outcome.modelFailure !== undefined
              ? { modelFailure: input.outcome.modelFailure }
              : {}),
          };
    }

    if (input.outcome.status === "failed") {
      await this.options.store.completeTurn({
        ...ref,
        status: "failed",
        cursor: input.cursor,
        messageId: null,
      });
      return {
        status: "failed",
        reason: input.outcome.reason,
        ...(input.outcome.modelFailure === undefined
          ? {}
          : { modelFailure: input.outcome.modelFailure }),
      };
    }

    // A Turn that stops to ask is not a Turn that said nothing: it has run Tools, written prose and
    // rendered a question, all of which the reader is looking at. Completing it without a Message
    // left every one of those on the wire only, so a refresh emptied the reply and stranded the
    // question the Turn is waiting on.
    const messageId = await this.persistReply(ref, input, input.outcome.text);
    await this.options.store.completeTurn({
      ...ref,
      status: "succeeded",
      cursor: input.cursor,
      messageId,
      conversationId: input.conversationId,
      surfaces: input.surfaces ?? [],
    });
    return { status: "succeeded", messageId };
  }

  /** Writes the reply the reader watched arrive; returns the Message it produced, if any. */
  private async persistReply(
    ref: TurnCompletionRef,
    input: CompleteTurnInput,
    text: string
  ): Promise<string | null> {
    // An empty reply with nothing to report is no reply; writing it would put a blank turn in the
    // transcript. A reply that ran Tools is never empty, even when the model wrote no prose.
    if (text.length === 0 && (input.metadata?.toolCalls ?? []).length === 0) return null;

    const { messageId } = await this.options.store.appendAssistantMessage({
      ...ref,
      conversationId: input.conversationId,
      content: text,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
    return messageId;
  }
}
