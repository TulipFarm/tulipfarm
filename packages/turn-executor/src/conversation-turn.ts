/** Complete by `(turnId, attempt)`; redelivery is idempotent and stale attempts cannot win. */

import type { ModelFailureDiagnostic } from "@tulipfarm/agent-runtime";
import { RunInterruptedError } from "@tulipfarm/run-kernel";
import type { ParticipantToolCall } from "@tulipfarm/schema";
import type { TurnAttemptHistory, TurnSurfaceRef } from "./run-events";

export type TurnCompletionStatus = "succeeded" | "failed";

export interface TurnCompletionRecord {
  readonly turnId: string;
  readonly attempt: number;
  readonly status: TurnCompletionStatus;
  readonly messageId: string | null;
}

export type TurnPersistenceStatus = "recorded" | "replayed" | "stale" | "ownership_lost";

export type AssistantMessageWriteResult =
  | { readonly status?: "recorded" | "replayed"; readonly messageId: string }
  | { readonly status: "stale" | "ownership_lost"; readonly messageId: null };

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
      leaseGeneration: number;
      conversationId: string;
      content: string;
      metadata?: TurnAttemptMessageMetadata;
    }
  ): Promise<AssistantMessageWriteResult>;
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
      leaseGeneration: number;
      status: TurnCompletionStatus;
      cursor: number;
      messageId: string | null;
      conversationId?: string;
      surfaces?: readonly TurnSurfaceLink[];
      /** Bounded, participant-safe failure evidence; absent for a succeeded completion. */
      reason?: string;
      modelFailure?: ModelFailureDiagnostic;
      /** Present only for `tool_call_limit`, so a participant-facing message can say "N of M". */
      toolCallBudget?: { used: number; max: number };
    }
    // biome-ignore lint/suspicious/noConfusingVoidType: Eval's in-process adapter remains legacy-compatible.
  ): Promise<{ readonly status: TurnPersistenceStatus } | void>;
}

export interface TurnSurfaceLink {
  readonly artifactId: string;
  readonly revision: number;
}

/** Durable Message metadata that identifies and bounds one Turn attempt's safe history. */
export interface TurnAttemptMessageMetadata extends Record<string, unknown> {
  readonly toolCalls?: readonly ParticipantToolCall[];
  readonly surfaces?: readonly TurnSurfaceRef[];
  readonly turnAttempt: {
    readonly runId: string;
    readonly attempt: number;
    readonly cursor: number;
    readonly outcome: TurnAttemptHistory["outcome"];
    readonly complete: boolean;
    readonly wait?: TurnAttemptHistory["wait"];
  };
}

export type TurnOutcome =
  | { readonly status: "succeeded"; readonly text: string }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly modelFailure?: ModelFailureDiagnostic;
      /** Present only for `tool_call_limit`, so a participant-facing message can say "N of M". */
      readonly toolCallBudget?: { readonly used: number; readonly max: number };
    }
  | { readonly status: "input_required"; readonly text: string }
  | { readonly status: "waiting"; readonly waitId: string };

export interface CompleteTurnInput {
  readonly businessId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly attempt: number;
  readonly leaseGeneration: number;
  /** Last Run event sequence for this attempt; readers resume strictly after it. */
  readonly cursor: number;
  readonly outcome: TurnOutcome;
  readonly history?: TurnAttemptHistory;
  /** Compatibility input for callers that have not assembled a full history snapshot. */
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
      readonly messageId: string | null;
      readonly modelFailure?: ModelFailureDiagnostic;
      /** Present only for `tool_call_limit`, so a participant-facing message can say "N of M". */
      readonly toolCallBudget?: { readonly used: number; readonly max: number };
    }
  | { readonly status: "waiting"; readonly waitId: string }
  | { readonly status: "stale" };

export interface ConversationTurnCompleterOptions {
  readonly store: TurnCompletionStore;
}

type TurnCheckpointResult =
  | AssistantMessageWriteResult
  | { readonly status: "empty"; readonly messageId: null };

export class ConversationTurnCompleter {
  constructor(private readonly options: ConversationTurnCompleterOptions) {}

  /** Check before spending model/tool work; `complete` enforces the same stale-attempt rule. */
  isStale(input: Pick<CompleteTurnInput, "attempt" | "latestAttempt">): boolean {
    return input.latestAttempt !== undefined && input.latestAttempt > input.attempt;
  }

  /** Saves participant-safe progress without settling the Turn. Repeated saves update one Message. */
  async checkpoint(
    input: TurnCompletionRef & {
      readonly leaseGeneration: number;
      readonly conversationId: string;
      readonly history: TurnAttemptHistory;
    }
  ): Promise<TurnCheckpointResult> {
    if (
      input.history.text.length === 0 &&
      input.history.toolCalls.length === 0 &&
      input.history.surfaces.length === 0
    ) {
      return { status: "empty", messageId: null };
    }
    const result = await this.options.store.appendAssistantMessage({
      businessId: input.businessId,
      runId: input.runId,
      turnId: input.turnId,
      attempt: input.attempt,
      leaseGeneration: input.leaseGeneration,
      conversationId: input.conversationId,
      content: input.history.text,
      metadata: historyMetadata(input, input.history),
    });
    if (result.status === "ownership_lost") throw new RunInterruptedError();
    return result;
  }

  async complete(input: CompleteTurnInput): Promise<CompleteTurnResult> {
    if (this.isStale(input)) return { status: "stale" };

    if (input.outcome.status === "waiting") {
      // The Turn is parked on a durable wait; resuming it will complete it later.
      return { status: "waiting", waitId: input.outcome.waitId };
    }

    const ref: TurnCompletionRef & { readonly leaseGeneration: number } = {
      businessId: input.businessId,
      runId: input.runId,
      turnId: input.turnId,
      attempt: input.attempt,
      leaseGeneration: input.leaseGeneration,
    };
    const history = input.history ?? fallbackHistory(input);

    const existing = await this.options.store.findCompletion(ref);
    if (existing !== undefined) {
      return existing.status === "succeeded"
        ? { status: "succeeded", messageId: existing.messageId }
        : {
            status: "failed",
            reason: input.outcome.status === "failed" ? input.outcome.reason : "",
            messageId: existing.messageId,
            ...(input.outcome.status === "failed" && input.outcome.modelFailure !== undefined
              ? { modelFailure: input.outcome.modelFailure }
              : {}),
            ...(input.outcome.status === "failed" && input.outcome.toolCallBudget !== undefined
              ? { toolCallBudget: input.outcome.toolCallBudget }
              : {}),
          };
    }

    if (input.outcome.status === "failed") {
      const checkpoint = await this.checkpoint({
        ...ref,
        conversationId: input.conversationId,
        history,
      });
      if (checkpoint.status === "ownership_lost") throw new RunInterruptedError();
      if (checkpoint.status === "stale") return { status: "stale" };
      const completion = await this.options.store.completeTurn({
        ...ref,
        status: "failed",
        cursor: input.cursor,
        messageId: checkpoint.messageId,
        conversationId: input.conversationId,
        surfaces: input.surfaces ?? [],
        reason: input.outcome.reason,
        ...(input.outcome.modelFailure === undefined
          ? {}
          : { modelFailure: input.outcome.modelFailure }),
        ...(input.outcome.toolCallBudget === undefined
          ? {}
          : { toolCallBudget: input.outcome.toolCallBudget }),
      });
      if (completion?.status === "ownership_lost") throw new RunInterruptedError();
      if (completion?.status === "stale") return { status: "stale" };
      return {
        status: "failed",
        reason: input.outcome.reason,
        messageId: checkpoint.messageId,
        ...(input.outcome.modelFailure === undefined
          ? {}
          : { modelFailure: input.outcome.modelFailure }),
        ...(input.outcome.toolCallBudget === undefined
          ? {}
          : { toolCallBudget: input.outcome.toolCallBudget }),
      };
    }

    // A Turn that stops to ask is not a Turn that said nothing: it has run Tools, written prose and
    // rendered a question, all of which the reader is looking at. Completing it without a Message
    // left every one of those on the wire only, so a refresh emptied the reply and stranded the
    // question the Turn is waiting on.
    const checkpoint = await this.checkpoint({
      ...ref,
      conversationId: input.conversationId,
      history,
    });
    if (checkpoint.status === "ownership_lost") throw new RunInterruptedError();
    if (checkpoint.status === "stale") return { status: "stale" };
    const completion = await this.options.store.completeTurn({
      ...ref,
      status: "succeeded",
      cursor: input.cursor,
      messageId: checkpoint.messageId,
      conversationId: input.conversationId,
      surfaces: input.surfaces ?? [],
    });
    if (completion?.status === "ownership_lost") throw new RunInterruptedError();
    return completion?.status === "stale"
      ? { status: "stale" }
      : { status: "succeeded", messageId: checkpoint.messageId };
  }
}

function fallbackHistory(input: CompleteTurnInput): TurnAttemptHistory {
  const text =
    input.outcome.status === "succeeded" || input.outcome.status === "input_required"
      ? input.outcome.text
      : "";
  return {
    text,
    toolCalls: input.metadata?.toolCalls ?? [],
    surfaces: input.surfaces ?? [],
    cursor: input.cursor,
    outcome: input.outcome.status === "input_required" ? "succeeded" : input.outcome.status,
    complete: input.outcome.status !== "waiting",
  };
}

function historyMetadata(
  ref: Pick<TurnCompletionRef, "runId" | "attempt">,
  history: TurnAttemptHistory
): TurnAttemptMessageMetadata {
  return {
    ...(history.toolCalls.length === 0 ? {} : { toolCalls: history.toolCalls }),
    ...(history.surfaces.length === 0 ? {} : { surfaces: history.surfaces }),
    turnAttempt: {
      runId: ref.runId,
      attempt: ref.attempt,
      cursor: history.cursor,
      outcome: history.outcome,
      complete: history.complete,
      ...(history.wait === undefined ? {} : { wait: history.wait }),
    },
  };
}
