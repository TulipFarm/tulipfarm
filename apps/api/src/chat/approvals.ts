import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalGate, ApprovalRequestInfo } from "../tools/types";
import type { StreamEmitter } from "./stream-emitter";

/** A pending approval auto-denies after this long with no human decision. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  emitter: StreamEmitter;
  toolCallId: string;
}

/**
 * Process-wide registry of in-flight tool approvals (single-instance V1). A gated mutating tool
 * `request()`s a decision: we emit `approval-request`, suspend on a Promise, and auto-deny after
 * `APPROVAL_TIMEOUT_MS`. The decide route resolves it; either path emits `approval-resolved` (queued on
 * the same serialized emitter, so it always precedes the tool-result). Ephemeral — nothing is persisted
 * beyond the generic `stream_resume` buffer, so an API restart drops pending entries.
 */
export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingApproval>();

  /** Suspend a gated tool call until a human (or the timeout) decides. */
  request(emitter: StreamEmitter, info: ApprovalRequestInfo): Promise<ApprovalDecision> {
    const approvalId = randomUUID();
    const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString();
    const decision = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(
        () => this.settle(approvalId, { outcome: "timeout", reason: "approval request timed out" }),
        APPROVAL_TIMEOUT_MS
      );
      this.pending.set(approvalId, { resolve, timer, emitter, toolCallId: info.toolCallId });
    });
    void emitter.emit("approval-request", {
      approvalId,
      toolCallId: info.toolCallId,
      toolName: info.toolName,
      args: info.args,
      expiresAt,
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
    entry.resolve(decision);
  }
}

/** Bind the process registry to one turn's emitter → the gate the tool wrapper calls. */
export function makeApprovalGate(registry: ApprovalRegistry, emitter: StreamEmitter): ApprovalGate {
  return { request: (info) => registry.request(emitter, info) };
}
