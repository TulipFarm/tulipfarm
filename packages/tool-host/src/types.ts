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

export type ToolCallResult =
  | { success: true; data: unknown }
  | {
      success: false;
      error: { code: ToolErrorCode; message: string; connectUrl?: string };
    };

export const ok = (data: unknown): ToolCallResult => ({ success: true, data });

export const err = (code: ToolErrorCode, message: string, connectUrl?: string): ToolCallResult => ({
  success: false,
  error: { code, message, ...(connectUrl === undefined ? {} : { connectUrl }) },
});

export type ChatAutonomy = "full" | "supervised" | "approval-required" | "manual";
export interface ClientContext {
  route?: string;
  title?: string;
}

export interface RequestContext {
  userId: string;
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

export interface ToolDef {
  name: string;
  tier: ToolTier;
  mutating: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Builds a target-scoped schema without exposing cross-channel component vocabulary. */
  inputSchemaFor?: (ctx: RequestContext) => Record<string, unknown>;
  execute: (args: unknown, ctx: RequestContext) => Promise<ToolCallResult>;
  requiresApproval?: boolean;
  /**
   * The Tool's own declaration of what authority it needs (`defineTool`). Present on every Tool
   * built through `toToolDef`; the gate reads `authorization` and `targetsFor` from here. Optional
   * only so a Tool can be constructed directly in a test without a full declaration.
   */
  definition?: ApiToolDefinition<unknown>;
}

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
