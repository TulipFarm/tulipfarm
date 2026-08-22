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
  readonly turn: HostedTurnRef;
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
}

export interface HostedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly activeSkillName?: string;
}

/** Mirrors the loop's `ToolDispatchResult`, minus the `callId` the caller already holds. */
export type HostedToolResult =
  | { readonly status: "succeeded"; readonly output: unknown }
  | { readonly status: "denied"; readonly reason: string; readonly connectUrl?: string }
  | { readonly status: "invalid_arguments"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "awaiting_approval"; readonly approvalId: string };

export interface TurnToolDispatcher {
  dispatch(authority: TurnAuthority, call: HostedToolCall): Promise<HostedToolResult>;
}
