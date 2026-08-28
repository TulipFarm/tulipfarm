import type { InvocationPrincipal } from "@tulipfarm/run-kernel";
import type { HostedAgent } from "./ports";

/**
 * The Run-derived authority a Tool call executes under. It names only what the Run itself
 * recorded, never what the caller claimed, so the same object is safe to build in the control
 * plane from an HTTP request or in the durable runtime from a claimed Run row.
 */

/** The part of a Turn a Tool call needs. A persisted Turn record satisfies it. */
export interface HostedTurnRef {
  readonly id: string;
  readonly conversationId: string;
  readonly attempt: number;
}

/** What one Run may do, taken from the Run itself rather than from whoever asked. */
export interface TurnAuthority {
  readonly businessId: string;
  readonly runId: string;
  /**
   * The Conversation Turn this Run answers, when it answers one.
   *
   * Absent for a Run that is not a Conversation — a Routine Run has no participant and no Turn
   * row, and a sub-agent Run reasons into an Artifact instead. Authorization never depended on
   * the Turn; only presentation and conversation-scoped Tool context did. A Tool that needs
   * somewhere to speak must handle its absence rather than assume a Turn, since inventing a
   * Conversation id here would let a Tool write into a Conversation nobody can read.
   */
  readonly turn?: HostedTurnRef;
  /** Whom the turn acts as, as recorded when the Run was minted. */
  readonly subject: InvocationPrincipal;
  /** Worker executor kind; determines which Artifact carries the request payload. */
  readonly source: string;
  /** The Run's bundle digest, recorded on the Context manifest as what produced this Context. */
  readonly bundleDigest: string;
  /**
   * The Agent this Run routes to, as the control plane resolved it from the Soul.
   *
   * A process that hosts Tools without a Soul cannot answer "what may this Agent do" for itself,
   * and a bound it cannot read is a bound it does not enforce. Carrying the resolved Agent on the
   * Run-derived authority is what lets the durable runtime apply the same autonomy ceiling and the
   * same capability restrictions the control plane would, rather than falling back to an
   * unrestricted default. A process that resolves the Agent locally ignores this and uses its own.
   */
  readonly agent?: HostedAgent;
  /**
   * The Routine this Run executes, when it executes one.
   *
   * The Routine-only Tool `complete_state` refuses a call that names no Routine, so without this
   * an Agent State could reach it in its catalog and never use it.
   */
  readonly routineId?: string;
}

export interface HostedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  /** The Run State this call executes in; a Tool that parks registers its wait against it. */
  readonly stateId?: string;
  readonly activeSkillName?: string;
  /**
   * The Agent the caller is acting as, for a Run whose request Artifact does not name one — today
   * a Routine `agent` State, whose Agent is chosen per State rather than per Run.
   *
   * A claim, not authority: the control plane accepts it only after finding it named by a State of
   * the Run's own Routine, so an unrecognised name resolves to no Agent and narrows the call.
   */
  readonly agentName?: string;
  /**
   * A ceiling the caller asks to be held to, from a Routine State's authored `permissionCeiling`.
   *
   * Safe to accept from the Worker because it only ever narrows: the gate refuses a Tool above it
   * and grants nothing, so a forged value can deny a call but never widen one.
   */
  readonly permissionCeiling?: { readonly maxRiskClass?: string };
}

/** Mirrors the loop's `ToolDispatchResult`, minus the `callId` the caller already holds. */
export type HostedToolResult =
  | {
      readonly status: "succeeded";
      readonly output: unknown;
      /**
       * The effect had already confirmed, so `output` is a marker rather than what the Tool
       * returned — the ledger records that a call happened, not what it answered. Chat can say
       * so in words; a caller that feeds the output to a later step must not treat it as data.
       */
      readonly replayed?: true;
    }
  | { readonly status: "denied"; readonly reason: string; readonly connectUrl?: string }
  | { readonly status: "invalid_arguments"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "awaiting_approval"; readonly approvalId: string }
  | {
      /** The Tool spawned a child Run and registered the wait that resumes this Turn. */
      readonly status: "awaiting_child";
      readonly childRunId: string;
      readonly waitId: string;
    };

export interface TurnToolDispatcher {
  dispatch(authority: TurnAuthority, call: HostedToolCall): Promise<HostedToolResult>;
}
