import { randomUUID } from "node:crypto";
import type { ApprovalsRepo } from "../approvals/repo";
import type { ApprovalDecision, ApprovalGate, ApprovalRequestInfo } from "../tools/types";
import type { StreamEmitter } from "./stream-emitter";

/** A pending approval auto-denies after this long with no human decision. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  emitter: StreamEmitter;
  toolCallId: string;
  // Retained so listPending() can project a row without re-deriving from the (per-stream) emitter.
  approvalId: string;
  toolName: string;
  args: unknown;
  expiresAt: string;
  createdAt: string;
}

/** A serializable projection of one in-flight approval, for the list endpoint + sidebar badge. */
export interface PendingApprovalSummary {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  expiresAt: string;
  createdAt: string;
}

/**
 * Process-wide registry of in-flight tool approvals (single-instance V1). A gated mutating tool
 * `request()`s a decision: we emit `approval-request`, suspend on a Promise, and auto-deny after
 * `APPROVAL_TIMEOUT_MS`. The decide route resolves it; either path emits `approval-resolved` (queued on
 * the same serialized emitter, so it always precedes the tool-result). Ephemeral — nothing is persisted
 * beyond the generic `stream_resume` buffer, so an API restart drops pending entries.
 * An optional `ApprovalsRepo` receives fire-and-forget writes for audit and future routine support.
 */
export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly repo?: ApprovalsRepo) {}

  /** Suspend a gated tool call until a human (or the timeout) decides. */
  request(emitter: StreamEmitter, info: ApprovalRequestInfo): Promise<ApprovalDecision> {
    const approvalId = randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString();
    const decision = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(
        () => this.settle(approvalId, { outcome: "timeout", reason: "approval request timed out" }),
        APPROVAL_TIMEOUT_MS
      );
      this.pending.set(approvalId, {
        resolve,
        timer,
        emitter,
        toolCallId: info.toolCallId,
        approvalId,
        toolName: info.toolName,
        args: info.args,
        expiresAt,
        createdAt,
      });
    });
    void emitter.emit("approval-request", {
      approvalId,
      toolCallId: info.toolCallId,
      toolName: info.toolName,
      args: info.args,
      expiresAt,
    });
    void this.repo?.insert({
      id: approvalId,
      kind: "tool_call",
      payload: { toolCallId: info.toolCallId, toolName: info.toolName, args: info.args },
      expiresAt: new Date(expiresAt),
    });
    return decision;
  }

  /** Resolve a pending approval from the decide route. False if unknown or already settled. */
  decide(approvalId: string, outcome: "approved" | "denied"): boolean {
    if (!this.pending.has(approvalId)) return false;
    this.settle(
      approvalId,
      outcome === "approved"
        ? { outcome: "approved" }
        : { outcome: "denied", reason: "denied by operator" }
    );
    return true;
  }

  /** Snapshot all in-flight approvals, oldest first. Ephemeral — empties on API restart. */
  listPending(): PendingApprovalSummary[] {
    return [...this.pending.values()]
      .map((e) => ({
        approvalId: e.approvalId,
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        args: e.args,
        expiresAt: e.expiresAt,
        createdAt: e.createdAt,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private settle(approvalId: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    void entry.emitter.emit("approval-resolved", {
      approvalId,
      toolCallId: entry.toolCallId,
      outcome: decision.outcome,
    });
    void this.repo?.settle(
      approvalId,
      decision.outcome === "approved"
        ? "approved"
        : decision.outcome === "denied"
          ? "denied"
          : "timeout"
    );
    entry.resolve(decision);
  }
}

/** Bind the process registry to one turn's emitter → the gate the tool wrapper calls. */
export function makeApprovalGate(registry: ApprovalRegistry, emitter: StreamEmitter): ApprovalGate {
  return { request: (info) => registry.request(emitter, info) };
}
