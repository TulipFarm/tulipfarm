import { randomUUID } from "node:crypto";
import type { InvocationPrincipal } from "@tulipfarm/run-kernel";
import { DurableWaitError, type DurableWaitManager } from "@tulipfarm/run-kernel";
import { canonicalHash } from "@tulipfarm/schema";
import type { ToolApprovalDecision, ToolApprovalPort } from "../ports";
import type { ApprovalRow, ApprovalsRepo } from "./repo";

/** Durable Tool approvals: intent-keyed rows park the Run; one-use wait tokens resume it.
 *
 * A decision is one-use as well (invariant I-13): `decide` hands back the approval id and the
 * dispatch that will actually execute spends it through `consume`. Consumption, not lookup, is
 * the spend point — a parked call leaves with `pending` and spends nothing, so the Turn that
 * resumes still finds its decision, while a *second* identical call in the same Run finds none
 * and asks a human again.
 */

/** The schema every approval signal declares. Identity only — a decision carries no payload. */
export const APPROVAL_SIGNAL_SCHEMA_REF = "tulipfarm.approval.decision.v1";

/** Approval deadline: one day; durable waits are not bound by HTTP handler lifetime. */
export const APPROVAL_WAIT_TTL_MS = 24 * 60 * 60_000;

export type ApprovalSignalOutcome = "resumed" | "already_settled" | "forbidden" | "not_found";

export interface ToolApprovalPayload {
  readonly runId: string;
  readonly intentDigest: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  /** Present once the Run actually parked; absent while the loop is still deciding to. */
  readonly waitId?: string;
}

export interface ToolApprovalServiceOptions {
  readonly repo: ApprovalsRepo;
  readonly waits: DurableWaitManager;
  newId?(): string;
  now?(): Date;
  readonly ttlMs?: number;
}

/** A settled row's status, as the dispatcher must read it. `timeout` is a denial with a reason. */
function decisionFor(row: ApprovalRow): ToolApprovalDecision {
  switch (row.status) {
    case "approved":
      return { status: "approved", approvalId: row.id };
    case "denied":
      return { status: "denied", reason: "denied by operator" };
    case "timeout":
      return { status: "denied", reason: "approval request timed out" };
    case "pending":
      return { status: "pending", approvalId: row.id };
  }
}

function payloadOf(row: ApprovalRow): Partial<ToolApprovalPayload> {
  return typeof row.payload === "object" && row.payload !== null
    ? (row.payload as Partial<ToolApprovalPayload>)
    : {};
}

export class ToolApprovalService implements ToolApprovalPort {
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(private readonly options: ToolApprovalServiceOptions) {
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? APPROVAL_WAIT_TTL_MS;
  }

  /** Returns or requests the standing decision for one Tool intent. */
  async decide(input: {
    businessId: string;
    runId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
  }): Promise<ToolApprovalDecision> {
    const intentDigest = intentOf(input.runId, input.toolName, input.args);
    const existing = await this.options.repo.findByIntent(
      input.runId,
      intentDigest,
      input.toolCallId
    );
    if (existing !== null) return decisionFor(existing);

    const approvalId = this.newId();
    const payload: ToolApprovalPayload = {
      runId: input.runId,
      intentDigest,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
    };
    await this.options.repo.insert({
      id: approvalId,
      kind: "tool_call",
      payload,
      expiresAt: new Date(this.now().getTime() + this.ttlMs),
    });
    return { status: "pending", approvalId };
  }

  /**
   * Spends the one-use decision on behalf of the dispatch about to execute it. `false` means this
   * call may not run: the row is not an open approval, or another call already spent it.
   */
  async consume(input: { approvalId: string; toolCallId: string }): Promise<boolean> {
    return await this.options.repo.consume(input.approvalId, input.toolCallId, this.now());
  }

  /** Parks idempotently; stores a one-use server-only token, while the wait stores its digest. */
  async registerWait(input: {
    businessId: string;
    runId: string;
    stateKey: string;
    approvalId: string;
    subject: InvocationPrincipal;
  }): Promise<{ waitId: string }> {
    const row = await this.options.repo.findById(input.approvalId);
    if (row === null) throw new UnknownApprovalError(input.approvalId);
    const existing = payloadOf(row).waitId;
    if (existing !== undefined) return { waitId: existing };

    const registered = await this.options.waits.register({
      id: this.newId(),
      businessId: input.businessId,
      runId: input.runId,
      stateKey: input.stateKey,
      kind: "approval",
      aggregation: "first",
      schemaRef: APPROVAL_SIGNAL_SCHEMA_REF,
      // The person the turn acts as is the person who decides its approvals. Recorded on the wait
      // so the kernel enforces it under the row lock, rather than a route deciding case by case.
      allowedPrincipals: [`${input.subject.kind}:${input.subject.id}`],
      expectedSignals: 1,
      quorum: null,
      deadlineAt: row.expiresAt.toISOString(),
      createdAt: this.now().toISOString(),
    });
    await this.options.repo.mergePayload(input.approvalId, {
      waitId: registered.wait.id,
      resumeToken: registered.token,
    });
    return { waitId: registered.wait.id };
  }

  /** Pending approval a Channel host can prompt for. */
  async pendingForRun(
    runId: string
  ): Promise<{ approvalId: string; toolName: string; args: unknown } | null> {
    const row = await this.options.repo.findPendingByRun(runId);
    if (row === null) return null;
    const payload = payloadOf(row);
    return {
      approvalId: row.id,
      toolName: payload.toolName ?? "unknown tool",
      args: payload.args,
    };
  }

  /** Checks principal, settles row, then signals wait so resumed dispatch does not re-park. */
  async signal(input: {
    businessId: string;
    approvalId: string;
    decision: "approved" | "denied";
    principal: string;
  }): Promise<ApprovalSignalOutcome> {
    const row = await this.options.repo.findById(input.approvalId);
    if (row === null || row.kind !== "tool_call") return "not_found";
    const payload = payloadOf(row);
    const { waitId, runId, resumeToken } = payload as ToolApprovalPayload & {
      resumeToken?: string;
    };
    if (waitId === undefined || runId === undefined || resumeToken === undefined) {
      // Not a worker-executed approval — the caller falls through to the path that owns it.
      return "not_found";
    }

    const wait = await this.options.waits.find(input.businessId, waitId);
    if (wait === null) return "not_found";
    if (!wait.allowedPrincipals.includes(input.principal)) return "forbidden";

    if (!(await this.options.repo.settlePending(input.approvalId, input.decision))) {
      return "already_settled";
    }

    try {
      await this.options.waits.signal({
        id: this.newId(),
        businessId: input.businessId,
        runId,
        token: resumeToken,
        principal: input.principal,
        schemaRef: APPROVAL_SIGNAL_SCHEMA_REF,
        // One decision per approval: a replayed request redeems nothing a second time.
        correlationKey: `approval:${input.approvalId}`,
        signalDigest: canonicalHash({ approvalId: input.approvalId, decision: input.decision }),
        receivedAt: this.now().toISOString(),
      });
    } catch (error) {
      // The decision is recorded either way — a wait already resolved by the deadline sweep, or by
      // a racing decision, must not turn a settled approval into a failed request.
      if (!(error instanceof DurableWaitError)) throw error;
      return "already_settled";
    }
    return "resumed";
  }
}

export class UnknownApprovalError extends Error {
  readonly name = "UnknownApprovalError";

  constructor(readonly approvalId: string) {
    super(`approval ${approvalId} does not exist`);
  }
}

/** Approval intent: this Run, Tool, and arguments; never the call id. */
export function intentOf(runId: string, toolName: string, args: unknown): string {
  return canonicalHash({ runId, toolName, args: args ?? null });
}
