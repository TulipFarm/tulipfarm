import {
  type ArtifactService,
  INVOKE_STATE_KEY,
  RUN_EXECUTOR_PRINCIPAL_REF,
} from "@tulipfarm/run-kernel";
import { SUBAGENT_ANSWER_SCHEMA_REF } from "@tulipfarm/schema";
import type {
  TurnCompletionRecord,
  TurnCompletionRef,
  TurnCompletionStatus,
  TurnCompletionStore,
} from "@tulipfarm/turn-executor";

/** Where a sub-agent Run leaves its answer, keyed off the Run so the parent can find it. */
export function subagentAnswerArtifactId(runId: string): string {
  return `${runId}:answer`;
}

/**
 * Names the "Turn" a sub-agent Run answers.
 *
 * A sub-agent has no Conversation, but the Turn machinery needs a stable pair of ids to key events
 * and completion by. Both of these are real and unique — the Run's single `invoke` State and the
 * Run itself — rather than an invented Conversation id that would point at nothing. Nothing
 * dereferences either: the completion store below is Artifact-backed, and the driver carries
 * `conversationId` only as a label on events and spend.
 */
export function subagentTurnIdentity(runId: string): {
  turnId: string;
  conversationId: string;
  attempt: number;
} {
  return { turnId: INVOKE_STATE_KEY, conversationId: runId, attempt: 1 };
}

export interface SubagentCompletionStoreOptions {
  readonly artifacts: Pick<ArtifactService, "read" | "publish">;
  now?(): Date;
}

/**
 * Completes a sub-agent Run into an Artifact instead of a Conversation Message.
 *
 * Satisfies the same {@link TurnCompletionStore} the chat executor uses, which is what lets a
 * sub-agent reuse that executor whole — and with it the identical guardrail, budget, checkpoint
 * and cancellation wiring. A bespoke executor would be free to drift from that stack, and every
 * way it could drift is a way a sub-agent ends up less governed than a chat Turn.
 */
export class SubagentCompletionStore implements TurnCompletionStore {
  private readonly now: () => Date;

  constructor(private readonly options: SubagentCompletionStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Redelivery check: an answer Artifact that already exists means this Run was answered.
   *
   * The Artifact is the completion record, so there is no second write that could disagree with
   * it — the state a redelivered attempt must not duplicate is the same state it reads here.
   */
  async findCompletion(ref: TurnCompletionRef): Promise<TurnCompletionRecord | undefined> {
    const artifactId = subagentAnswerArtifactId(ref.runId);
    try {
      await this.options.artifacts.read({
        businessId: ref.businessId,
        artifactId,
        reader: RUN_EXECUTOR_PRINCIPAL_REF,
        allowedClassifications: [],
        now: this.now(),
      });
    } catch {
      return undefined;
    }
    return { turnId: ref.turnId, attempt: ref.attempt, status: "succeeded", messageId: artifactId };
  }

  async appendAssistantMessage(
    input: TurnCompletionRef & { content: string }
  ): Promise<{ messageId: string }> {
    const artifactId = subagentAnswerArtifactId(input.runId);
    await this.options.artifacts.publish({
      id: artifactId,
      businessId: input.businessId,
      schemaRef: SUBAGENT_ANSWER_SCHEMA_REF,
      // `steps` is a digest for the parent's trace, not a transcript. The Run event stream is the
      // record; copying Tool output here would put unbounded, unredacted text in an append-only
      // Artifact that erasure would then have to reach.
      value: { answer: input.content, steps: [] },
      storage: "inline",
      classification: [],
      // Only the Run executor reads this: the parent reads it through its own delegation link, and
      // the trace UI reads Run events. Naming a person here would widen the answer beyond the
      // Run that asked for it.
      acl: { readers: [RUN_EXECUTOR_PRINCIPAL_REF] },
      retention: { policy: "standard", expiresAt: null },
      redaction: { redactedPaths: [] },
      producer: { runId: input.runId, stateKey: INVOKE_STATE_KEY, attempt: input.attempt },
      createdAt: this.now().toISOString(),
    });
    return { messageId: artifactId };
  }

  /**
   * Nothing further to record: publishing the answer above already made completion durable.
   *
   * A failed sub-agent publishes no answer, which is what the parent's delegation link reads as a
   * failure — the Run's own terminal status carries that, so there is no second place for the two
   * records to disagree.
   */
  async completeTurn(
    _input: TurnCompletionRef & {
      status: TurnCompletionStatus;
      cursor: number;
      messageId: string | null;
    }
  ): Promise<void> {}
}
