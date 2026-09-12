import type { ModelMessage } from "../ports";
import type { AgentLoopEvent, AgentLoopOutcome } from "./contract";

/**
 * What a parked or interrupted Agent loop must carry across process boundaries so the model reads
 * back the same transcript it built. Counters alone survive a park; without this, a resumed Turn
 * sees only the persisted text history and has no record that any Tool call ever happened.
 */
export interface AgentLoopResumeState {
  /** Transcript messages the loop appended beyond `AgentLoopInput.messages`. */
  readonly messages: readonly ModelMessage[];
  /** Keep this transcript after terminal delivery so a later attempt can retry from it. */
  readonly retryable?: true;
  /** Number of acknowledged retryable attempts, used to keep retry event identities monotonic. */
  readonly retryAttempt?: number;
  /**
   * A settled result whose terminal event may not have been acknowledged yet.
   *
   * The full immutable event is retained so recovery redelivers its original sequence and time.
   */
  readonly terminal?: {
    readonly outcome: AgentLoopOutcome;
    readonly event: AgentLoopEvent;
    /** Backward-compatible marker written before retry retention became attempt-level state. */
    readonly retryable?: true;
  };
  /**
   * The Tool call that parked this loop on an approval. It is recorded rather than replanned
   * because it provably never executed: the dispatcher reports `awaiting_approval` before it
   * runs the Tool, so replaying exactly this call performs the approved work exactly once.
   */
  readonly pendingCall?: {
    readonly callId: string;
    readonly name: string;
    readonly arguments: unknown;
  };
  /**
   * A model-produced batch made durable before its first dispatch.
   *
   * `nextCallIndex` is the first call whose result is not durable yet. Re-entering from here uses
   * the same call ids and never asks a model to invent replacements.
   */
  readonly pendingBatch?: {
    readonly calls: readonly {
      readonly callId: string;
      readonly name: string;
      readonly arguments: unknown;
    }[];
    readonly nextCallIndex: number;
  };
  /** Last loaded Skill, so narrowing does not silently re-widen the catalog on resume. */
  readonly activeSkillName?: string;
  /** Whether this Turn already published a report, so a resumed attempt still cannot write. */
  readonly reported?: boolean;
  /**
   * Files an Agent re-read into this Turn, so a resumed attempt still has what it went and got.
   *
   * Named, never carried: the bytes are fetched again — and authorized again — on the resumed
   * attempt, so a park that outlives a revocation does not smuggle a stale copy past it.
   */
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
  /** Loop event sequence already emitted, so resumed events do not collide on idempotency keys. */
  readonly sequence: number;
  /** Text delta index already released, so a reader's ordering stays monotonic across a park. */
  readonly textIndex: number;
}
