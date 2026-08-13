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
  /**
   * A transient failure of the machinery, not of the request: git index contention, a provider
   * 503, a lease lost to a concurrent writer. The identical call may succeed moments later.
   *
   * Distinct from `internal_error`, which is deterministic — a malformed provider response or a
   * violated invariant will reproduce exactly. Collapsing the two is what makes a lock collision
   * indistinguishable from a bug: the model is handed prose about a failure it cannot repair,
   * spends repair budget rewording arguments that were never wrong, and the person reading the
   * turn is told the platform is broken when it was merely busy.
   */
  | "unavailable";

/**
 * What kind of fault a code represents, and therefore who may act on it.
 *
 * **business** — deterministic. The request itself is the problem, so the answer is stable: the
 * model must see it, and retrying without changing something can only reproduce it. A denial is a
 * business fault even though nothing is malformed — the answer will not change on its own.
 *
 * **infrastructure** — transient. The request was fine and the machinery was not. Retrying is the
 * correct response and the model must *not* be asked to repair it, because there is nothing in the
 * arguments to fix.
 *
 * The mapping is a total record rather than a switch so that adding a `ToolErrorCode` without
 * classifying it is a compile error. An unclassified code would otherwise default to whatever the
 * first reader assumed, and both defaults are harmful: treating a denial as transient retries a
 * refusal until a budget runs out, while treating contention as deterministic turns a recoverable
 * blip into a failed Run.
 */
export const TOOL_FAULT_CLASS: Readonly<Record<ToolErrorCode, "business" | "infrastructure">> = {
  validation_error: "business",
  surface_invalid: "business",
  presentation_unavailable: "business",
  oversize_value: "business",
  not_found: "business",
  write_denied: "business",
  audit_required: "business",
  internal_error: "business",
  unavailable: "infrastructure",
};

/** Whether this fault is the machinery's and not the request's, and so may be retried. */
export function isInfrastructureFault(code: ToolErrorCode): boolean {
  return TOOL_FAULT_CLASS[code] === "infrastructure";
}

export type ToolCallResult =
  | { success: true; data: unknown }
  | { success: false; error: { code: ToolErrorCode; message: string } };

export const ok = (data: unknown): ToolCallResult => ({ success: true, data });

export const err = (code: ToolErrorCode, message: string): ToolCallResult => ({
  success: false,
  error: { code, message },
});

/** Chat autonomy mode for a turn (mirrors the POST /chat request field). */
export type ChatAutonomy = "full" | "supervised" | "approval-required" | "manual";
/** A read-only snapshot of what the user is looking at, sent with the Chat request. */
export interface ClientContext {
  /** Current route (pathname + search), e.g. "/resources/tickets/TICK-1042". */
  route?: string;
  /** Document title — usually reflects the viewed record/page. */
  title?: string;
}

/** Per-request caller identity. Service references are closed over at registration time. */
export interface RequestContext {
  userId: string;
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
  autonomy?: ChatAutonomy;
  /** What the user is viewing this turn — read by the `get_client_context` frontend tool. */
  clientContext?: ClientContext;
  /**
   * Per-turn flag flipped to true once `get_client_context` runs. Side-effecting frontend actions
   * (navigate_to / prefill_form / invoke_action) are gated on it so the agent reads where the user is
   * before acting. A mutable holder so the flip is visible to later tool calls in the same turn.
   */
  contextRead?: { value: boolean };
  /**
   * Set only on routine-spawned headless agent turns (v0.11). Threaded into the platform
   * tool context per-call so `call_skill` / `complete_state` see the run they belong to.
   */
  routineContext?: { routineId: string; runId: string };
  /**
   * Whose provider credential this call must spend (D7), resolved by `internal/credential-mode.ts`
   * before the Tool runs. Absent means the deployment's shared service credential — the case for
   * every local effect and for unattended work.
   *
   * Present means the Tool must lease that principal's own sealed credential instead. A Tool that
   * ignores this would act as the bot while the gate believed a person was acting, so a provider
   * family that cannot honour it must not declare a user credential mode.
   */
  credentialPrincipal?: { readonly kind: string; readonly id: string };
}

/** Canonical tool shape for the ToolRegistry (TOOL-V1). */
export interface ToolDef {
  name: string;
  tier: ToolTier;
  mutating: boolean;
  description: string;
  /** Plain JSON Schema — fed to AJV in the handler and to jsonSchema() for the LLM API. */
  inputSchema: Record<string, unknown>;
  /** Builds a target-scoped schema without exposing cross-channel component vocabulary. */
  inputSchemaFor?: (ctx: RequestContext) => Record<string, unknown>;
  execute: (args: unknown, ctx: RequestContext) => Promise<ToolCallResult>;
  requiresApproval?: boolean;
  /**
   * The Tool's own declaration of what authority it needs (`defineTool`). Present on every Tool
   * built through `toToolDef`; the gate reads `authorization` and `targetsFor` from here.
   *
   * Optional only so a Tool can be constructed directly in a test without a full declaration. A
   * fitness check asserts every *registered* Tool carries one, so production has no such gap.
   */
  definition?: ApiToolDefinition<unknown>;
}

/** Outcome of a human approval for a gated (mutating + approval-required) tool call. */
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
import type { SurfaceActionStore } from "../surfaces/action-store";
import type { SurfaceArtifactStore } from "../surfaces/artifact-store";
import type { ApiToolDefinition } from "./define";
