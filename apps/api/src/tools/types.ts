export type ToolTier = "system" | "platform" | "integration";

export type ToolErrorCode =
  | "validation_error"
  | "surface_invalid"
  | "presentation_unavailable"
  | "oversize_value"
  | "not_found"
  | "internal_error"
  | "audit_required";

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
import type {
  PresentationContext,
  SoulSurfaceComponent,
  SurfaceComponentDefinition,
  SurfaceRendererManifest,
} from "@tulipfarm/surface";
import type { SurfaceActionStore } from "../surfaces/action-store";
import type { SurfaceArtifactStore } from "../surfaces/artifact-store";
