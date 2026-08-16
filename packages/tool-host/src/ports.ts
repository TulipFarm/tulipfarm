import type {
  PresentationContext,
  SoulSurfaceComponent,
  SurfaceComponentDefinition,
  SurfaceRendererManifest,
  SurfaceTarget,
} from "@tulipfarm/surface";

/**
 * Ports the Tool host needs but must not own. Each one is something a process may legitimately
 * lack: a durable runtime that renders nothing has no renderer registry, and one that ships no
 * provider Tools has no install-status source. Absence is a capability statement, and every
 * consumer of these ports fails closed on it rather than assuming a permissive default.
 */

/**
 * Channel-native rendering. Supplied by the process that owns the renderer registry; a process
 * without it cannot offer any Tool whose declaration requires a presentation.
 */
export interface SurfacePresentationPort {
  contextFor(target: SurfaceTarget, destination: string): PresentationContext;
  catalogFor(
    target: SurfaceTarget,
    components?: readonly SoulSurfaceComponent[]
  ): readonly SurfaceComponentDefinition[];
  catalogRevisionFor(target: SurfaceTarget, components?: readonly SoulSurfaceComponent[]): string;
  /** `undefined` when no renderer claims the target; the Tool then receives no manifest. */
  manifestFor(target: SurfaceTarget): SurfaceRendererManifest | undefined;
}

/** Narrow read of one Run's Channel delivery correlation — just enough to resolve a target. */
export interface ChannelDeliveryReader {
  find(
    businessId: string,
    runId: string
  ): Promise<{ readonly provider: string; readonly destination: string } | null>;
}

/** The Agent a turn runs as, reduced to what Tool visibility and the gate actually read. */
export interface HostedAgent {
  readonly name: string;
  readonly toolAllowlist?: readonly string[];
}

/** Resolves the Agent named by a chat request. Absence collapses to the deployment default. */
export interface AgentResolver {
  resolve(agentId?: string): HostedAgent;
}

/**
 * Per-turn Tool suppression that no declaration can express, because it depends on live state —
 * today, whether the GitHub App is installed. Returning an empty set suppresses nothing.
 */
export interface ToolVisibilityPort {
  excludedToolNames(businessId: string): Promise<ReadonlySet<string>>;
}

/** The guardrail revision a turn is bound to. `GuardrailsService` satisfies it structurally. */
export interface GuardrailRevisionSource {
  readonly revision: string;
}

/** What the dispatcher does with a Tool call that needs a human. */
export type ToolApprovalDecision =
  | { readonly status: "approved"; readonly approvalId: string }
  | { readonly status: "denied"; readonly reason: string }
  | { readonly status: "pending"; readonly approvalId: string };

/**
 * The one-use decision for one Tool intent. Deliberately excludes wait registration: parking a
 * Run mints a one-use resume token, and that token must never reach a process that only executes.
 */
export interface ToolApprovalPort {
  decide(input: {
    businessId: string;
    runId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
  }): Promise<ToolApprovalDecision>;
  /**
   * Spends an approved decision at the dispatch that will execute it. `false` means the decision
   * is no longer available to this call — another call spent it — and the dispatch must be
   * refused rather than run on an approval nobody granted it.
   */
  consume(input: { approvalId: string; toolCallId: string }): Promise<boolean>;
}
