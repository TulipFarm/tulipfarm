export type ToolTier = "system" | "platform" | "integration";

export type ToolErrorCode =
  | "validation_error"
  | "surface_invalid"
  | "presentation_unavailable"
  | "oversize_value"
  | "not_found"
  | "internal_error"
  /** Well-formed request, refused by policy. The reason stays server-side — see `err`'s callers. */
  | "write_denied"
  | "audit_required"
  | "credential_required"
  /**
   * A transient failure of the machinery, not of the request: git index contention, a provider 503,
   * a lease lost to a concurrent writer. Distinct from `internal_error`, which is deterministic — a
   * malformed provider response or a violated invariant will reproduce exactly. Collapsing the two
   * is what makes a lock collision indistinguishable from a bug: the model is handed prose about a
   * failure it cannot repair, spends repair budget rewording arguments that were never wrong, and
   * the person reading the turn is told the platform is broken when it was merely busy.
   */
  | "unavailable"
  /**
   * The call was abandoned — a deadline expired — without the work acknowledging its cancellation,
   * so whether the side effect landed is unknown. Neither `internal_error` nor `unavailable` can
   * carry this: one invites a repair the arguments do not need, the other invites the retry that
   * duplicates a payment, a notification, or a record write. Nothing may retry an indeterminate
   * call automatically; the effect is settled `ambiguous` and reconciliation decides.
   */
  | "indeterminate";

/**
 * What kind of fault a code represents, and therefore who may act on it. The request itself is the
 * problem, so the answer is stable: the model must see it, and retrying without changing something
 * can only reproduce it. Retrying is the correct response and the model must *not* be asked to
 * repair it, because there is nothing in the arguments to fix.
 */
export const TOOL_FAULT_CLASS: Readonly<
  Record<ToolErrorCode, "business" | "infrastructure" | "indeterminate">
> = {
  validation_error: "business",
  surface_invalid: "business",
  presentation_unavailable: "business",
  oversize_value: "business",
  not_found: "business",
  write_denied: "business",
  audit_required: "business",
  credential_required: "business",
  internal_error: "business",
  unavailable: "infrastructure",
  indeterminate: "indeterminate",
};

export function isInfrastructureFault(code: ToolErrorCode): boolean {
  return TOOL_FAULT_CLASS[code] === "infrastructure";
}

/** True when the call's side effect may have landed, so only reconciliation may retry it. */
export function isIndeterminateFault(code: ToolErrorCode): boolean {
  return TOOL_FAULT_CLASS[code] === "indeterminate";
}

/**
 * Durable work a call started instead of returning a value, and the wait that will settle it.
 *
 * `kind` leaves room for future park reasons without reopening this contract.
 */
export interface ToolPark {
  readonly kind: "child_run";
  readonly childRunId: string;
  readonly waitId: string;
}

/**
 * A Tool call's verdict. Unchanged for the overwhelming majority of Tools, which cannot park.
 */
export type ToolCallResult =
  | { success: true; data: unknown }
  | {
      success: false;
      error: { code: ToolErrorCode; message: string; connectUrl?: string };
    };

/**
 * What the *host* may receive back from any Tool: a verdict, or a park.
 *
 * The parked member deliberately carries no `success`, because a park is neither. Leaving it
 * absent makes every `if (result.success)` fall through to the failure branch, where the missing
 * `error` is a compile error rather than a silent read of `undefined`.
 *
 * Only Tools declared with `defineParkableApiTool` can produce one, so a Tool that cannot park
 * keeps the two-member `ToolCallResult` and narrows exactly as it always did.
 */
export type ParkableToolCallResult = ToolCallResult | { success?: never; parked: ToolPark };

export const ok = (data: unknown): ToolCallResult => ({ success: true, data });

/** The call's side effect is done and durable; only its *result* is still outstanding. */
export const parked = (park: ToolPark): ParkableToolCallResult => ({ parked: park });

/** `in` alone widens to `unknown` here, because no verdict member declares `parked`. */
export function isParked(
  result: ParkableToolCallResult
): result is { success?: never; parked: ToolPark } {
  return "parked" in result;
}

/**
 * Collapses a park into a refusal for a caller that has no Run to suspend.
 *
 * Ingress, the direct model adapter and nested Tool calls all execute Tools outside a parkable
 * Turn. Returning the park to them would strand durable work nothing will ever resume, so it is
 * reported as a fault instead — the same reasoning these paths already apply to approvals.
 */
export function refuseParkedResult(
  result: ParkableToolCallResult,
  toolName: string
): ToolCallResult {
  return isParked(result)
    ? err("internal_error", `tool "${toolName}" cannot suspend a Turn on this path`)
    : result;
}

export const err = (code: ToolErrorCode, message: string, connectUrl?: string): ToolCallResult => ({
  success: false,
  error: { code, message, ...(connectUrl === undefined ? {} : { connectUrl }) },
});

/** Reports a Tool-host failure that a `ToolCallResult` cannot carry, e.g. an uncaught throw. */
export interface ToolHostLogger {
  error(message: string, error?: unknown): void;
}

export type ChatAutonomy = "full" | "supervised" | "approval-required" | "manual";
export interface ClientContext {
  route?: string;
  title?: string;
}

export interface RequestContext {
  userId: string;
  /**
   * The Run's effective subject, kind included. `userId` flattens it to an id, which is enough for
   * ownership checks but not for a Tool that mints work on the caller's behalf: such a Tool must
   * name the same principal the Run carries, not assume it is a user.
   */
  subject?: { readonly kind: string; readonly id: string };
  /** Aborts the active Tool call when its host deadline expires. */
  abortSignal?: AbortSignal;
  actor?: CommitActor;
  /** Server-resolved target. Request payloads cannot override it. */
  presentationContext?: PresentationContext;
  surfaceCatalog?: readonly SurfaceComponentDefinition[];
  surfaceCatalogRevision?: string;
  surfaceRendererManifest?: SurfaceRendererManifest;
  surfaceComponents?: readonly SoulSurfaceComponent[];
  conversationId?: string;
  surfaceStore?: SurfaceArtifactStore;
  surfaceActionStore?: SurfaceActionStore;
  guardrailRevision?: string;
  runId?: string;
  /** The Run State this call executes in, so a parking Tool registers its wait against it. */
  stateKey?: string;
  /** The hosted loop's call id for this invocation — used by Tools that need a stable per-call
   * occurrence key (e.g. integration-tier effect idempotency), not just the Run. */
  toolCallId?: string;
  events?: EventEmitter;
  agentId?: string;
  /** Skill that was explicitly loaded before this call; never inferred from Tool arguments. */
  activeSkillName?: string;
  autonomy?: ChatAutonomy;
  clientContext?: ClientContext;
  contextRead?: { value: boolean };
  routineContext?: { routineId: string; runId: string };
  /**
   * Whose provider credential this call must spend (D7), resolved by `internal/credential-mode.ts`
   * before the Tool runs. Absent means the deployment's shared service credential — the case for
   * every local effect and for unattended work. Present means the Tool must lease that principal's
   * own sealed credential instead.
   */
  credentialPrincipal?: { readonly kind: string; readonly id: string };
}

/**
 * A Tool ready to execute.
 *
 * `Result` defaults to the narrow verdict, so the overwhelming majority of Tools — which cannot
 * park — still narrow on `success` with no guard. Only a host that can actually suspend a Turn
 * declares `ParkableToolDef`, and `ToolDef` widens into it by return-type covariance.
 */
export interface ToolDef<Result extends ParkableToolCallResult = ToolCallResult> {
  name: string;
  tier: ToolTier;
  mutating: boolean;
  /**
   * True when a repeated call with identical arguments performs a genuine new real-world effect
   * rather than reproducing the same state — a Slack message sent, a GitHub issue filed. The Tool
   * loop re-runs an ordinary repeated call so the model can see and act on the repetition; a
   * side-effecting one is short-circuited instead, because "run it again" is never the right
   * default when running it again is the bug (#646).
   */
  sideEffecting?: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Builds a target-scoped schema without exposing cross-channel component vocabulary. */
  inputSchemaFor?: (ctx: RequestContext) => Record<string, unknown>;
  execute: (args: unknown, ctx: RequestContext) => Promise<Result>;
  requiresApproval?: boolean;
  /**
   * The Tool's own declaration of what authority it needs (`defineTool`). Present on every Tool
   * built through `toToolDef`; the gate reads `authorization` and `targetsFor` from here. Optional
   * only so a Tool can be constructed directly in a test without a full declaration.
   */
  definition?: ApiToolDefinition<unknown>;
}

/** A Tool a parking-capable host dispatches; only such a host may declare this. */
export type ParkableToolDef = ToolDef<ParkableToolCallResult>;

export type ApprovalDecision =
  | { outcome: "approved" }
  | { outcome: "denied" | "timeout"; reason: string };

export interface ApprovalRequestInfo {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/** Per-turn gate the tool wrapper calls to suspend a mutating tool until a human decides. */
export interface ApprovalGate {
  request(info: ApprovalRequestInfo): Promise<ApprovalDecision>;
}

import type { EventEmitter } from "node:events";
import type { CommitActor } from "@tulipfarm/soul";
import type {
  PresentationContext,
  SoulSurfaceComponent,
  SurfaceComponentDefinition,
  SurfaceRendererManifest,
} from "@tulipfarm/surface";
import type { ApiToolDefinition } from "./define";
import type { SurfaceActionStore, SurfaceArtifactStore } from "./surface-ports";
