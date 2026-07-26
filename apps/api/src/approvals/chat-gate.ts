import { randomUUID } from "node:crypto";
import type { StreamEmitter } from "../chat/stream-emitter";
import type { ApprovalDecision, ApprovalGate, ApprovalRequestInfo } from "../tools/types";
import type { ApprovalsRepo } from "./runtime-repo";

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  if (!resolveValue) throw new Error("failed to initialize deferred approval");
  return { promise, resolve: resolveValue };
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
 * Durable authority for tool approvals. PostgreSQL owns pending/settled state in production; this
 * process retains only the continuation needed to resume a currently connected stream. A decision
 * accepted after a restart is still durably settled for the Run recovery path.
 */
export class DurableApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly repo?: ApprovalsRepo) {}

  /** Persist, emit, then suspend a gated tool call until a human (or the timeout) decides. */
  async request(emitter: StreamEmitter, info: ApprovalRequestInfo): Promise<ApprovalDecision> {
    const approvalId = randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString();
    const decision = deferred<ApprovalDecision>();
    if (this.repo) {
      await this.repo.insert({
        id: approvalId,
        kind: "tool_call",
        payload: { toolCallId: info.toolCallId, toolName: info.toolName, args: info.args },
        expiresAt: new Date(expiresAt),
      });
    }
    const timer = setTimeout(() => {
      void this.timeout(approvalId);
    }, APPROVAL_TIMEOUT_MS);
    this.pending.set(approvalId, {
      resolve: decision.resolve,
      timer,
      emitter,
      toolCallId: info.toolCallId,
      approvalId,
      toolName: info.toolName,
      args: info.args,
      expiresAt,
      createdAt,
    });
    await emitter.emit("approval-request", {
      approvalId,
      toolCallId: info.toolCallId,
      toolName: info.toolName,
      args: info.args,
      expiresAt,
    });
    return decision.promise;
  }

  /** Durably resolve an approval. False if unknown or already settled. */
  async decide(approvalId: string, outcome: "approved" | "denied"): Promise<boolean> {
    if (this.repo && !(await this.repo.settlePending(approvalId, outcome))) return false;
    if (!this.repo && !this.pending.has(approvalId)) return false;
    this.settleLocal(
      approvalId,
      outcome === "approved"
        ? { outcome: "approved" }
        : { outcome: "denied", reason: "denied by operator" }
    );
    return true;
  }

  /** Snapshot durable pending approvals, oldest first. */
  async listPending(): Promise<PendingApprovalSummary[]> {
    if (this.repo) {
      const rows = await this.repo.listPending("tool_call");
      return rows.map((row) => {
        const payload =
          typeof row.payload === "object" && row.payload !== null
            ? (row.payload as Record<string, unknown>)
            : {};
        return {
          approvalId: row.id,
          toolCallId:
            typeof payload.toolCallId === "string" ? payload.toolCallId : "unknown-tool-call",
          toolName: typeof payload.toolName === "string" ? payload.toolName : "unknown-tool",
          args: payload.args,
          expiresAt: row.expiresAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        };
      });
    }
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

  private async timeout(approvalId: string): Promise<void> {
    if (this.repo && !(await this.repo.settlePending(approvalId, "timeout"))) return;
    this.settleLocal(approvalId, {
      outcome: "timeout",
      reason: "approval request timed out",
    });
  }

  private settleLocal(approvalId: string, decision: ApprovalDecision): void {
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
export function makeApprovalGate(
  registry: DurableApprovalGate,
  emitter: StreamEmitter
): ApprovalGate {
  return { request: (info) => registry.request(emitter, info) };
}
