import { randomUUID } from "node:crypto";
import type { InvocationPrincipal } from "@tulipfarm/run-kernel";
import { DurableWaitError, type DurableWaitManager } from "@tulipfarm/run-kernel";
import { canonicalHash } from "@tulipfarm/schema";
import type { ToolApprovalDecision, ToolApprovalPort } from "../ports";
import {
  type ApprovalDemand,
  type ApprovalGuardrailEvidence,
  approvalEvidenceDigest,
  readApprovalEvidence,
} from "./evidence";
import type { PendingToolApproval } from "./pending";
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

/** Roles whose holders may decide a Tool approval, mirroring the `approval` surface grant. */
export const APPROVAL_DECIDER_ROLES: readonly string[] = ["role:admin", "role:member"];

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
    /** The principal whose Turn is asking. Four-eyes has nothing to check without it. */
    requesterPrincipalId: string;
    /** What demanded a human, from the evaluation that demanded it. */
    demand: ApprovalDemand;
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
    const evidence: ApprovalGuardrailEvidence = {
      ...input.demand,
      toolName: input.toolName,
      intentDigest,
      demandedAt: this.now().toISOString(),
    };
    await this.options.repo.insert({
      id: approvalId,
      kind: "tool_call",
      payload,
      expiresAt: new Date(this.now().getTime() + this.ttlMs),
      requesterPrincipalId: input.requesterPrincipalId,
      evidence,
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
      // Four-eyes (I-13) needs somebody other than the requester to be able to decide, so the
      // wait admits the Roles that hold the `approval` surface as well as the requester. The
      // requester is kept because a deployment with no other eligible approver must not be unable
      // to decide at all; `signal` is what refuses self-approval when someone else could decide.
      allowedPrincipals: [`${input.subject.kind}:${input.subject.id}`, ...APPROVAL_DECIDER_ROLES],
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

  /** Pending approvals the principal may decide, projected only after durable authorization. */
  async listPendingFor(input: {
    businessId: string;
    principal: string;
  }): Promise<PendingToolApproval[]> {
    const rows = await this.options.repo.listPending("tool_call");
    const authorized = await Promise.all(
      rows.map(async (row) =>
        (await this.authorizedWait(row, input.businessId, input.principal)) === null ? null : row
      )
    );
    return authorized.flatMap((row) => (row === null ? [] : [pendingApprovalOf(row)]));
  }

  /**
   * Checks evidence and approver, settles the row, then signals the wait.
   *
   * Four-eyes (I-13): the principal that asked for an effect may not be the principal that
   * authorizes it, whenever any other principal could. Where nobody else could — a deployment
   * with exactly one active user — the requester decides and the row records them as the
   * approver, so the exemption is visible in the audit trail rather than silent. Refusing outright
   * would leave a solo deployment unable to run any approved Tool at all, which is a worse
   * failure than the one four-eyes prevents.
   */
  async signal(input: {
    businessId: string;
    approvalId: string;
    decision: "approved" | "denied";
    principal: string;
  }): Promise<ApprovalSignalOutcome> {
    const row = await this.options.repo.findById(input.approvalId);
    if (row === null || row.kind !== "tool_call") return "not_found";
    const payload = payloadOf(row) as ToolApprovalPayload & { resumeToken?: string };
    if (
      payload.waitId === undefined ||
      payload.runId === undefined ||
      payload.resumeToken === undefined
    ) {
      return "not_found";
    }
    const authorized = await this.authorizedWait(row, input.businessId, input.principal);
    if (authorized === null) return "forbidden";
    const { runId, resumeToken, principalAs } = authorized;

    if (
      !(await this.options.repo.settlePending(input.approvalId, input.decision, input.principal))
    ) {
      return "already_settled";
    }

    try {
      await this.options.waits.signal({
        id: this.newId(),
        businessId: input.businessId,
        runId,
        token: resumeToken,
        principal: principalAs,
        schemaRef: APPROVAL_SIGNAL_SCHEMA_REF,
        // One decision per approval: a replayed request redeems nothing a second time.
        correlationKey: `approval:${input.approvalId}`,
        signalDigest: canonicalHash({
          approvalId: input.approvalId,
          decision: input.decision,
          decidedBy: input.principal,
        }),
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

  private async authorizedWait(
    row: ApprovalRow,
    businessId: string,
    principal: string
  ): Promise<{ runId: string; resumeToken: string; principalAs: string } | null> {
    const { waitId, runId, resumeToken } = payloadOf(row) as ToolApprovalPayload & {
      resumeToken?: string;
    };
    if (waitId === undefined || runId === undefined || resumeToken === undefined) return null;
    const wait = await this.options.waits.find(businessId, waitId);
    if (wait === null) return null;

    const evidence = readApprovalEvidence(row.guardrailEvidence);
    if (
      evidence === null ||
      row.guardrailEvidenceDigest === null ||
      approvalEvidenceDigest(evidence) !== row.guardrailEvidenceDigest
    ) {
      return null;
    }

    const requester = row.requesterPrincipalId;
    if (requester === null) return null;
    const principalAs = await this.approverPrincipal(wait.allowedPrincipals, principal);
    if (principalAs === null) return null;
    if (
      principal === requester &&
      (await this.options.repo.countOtherEligibleApprovers(requester)) > 0
    ) {
      return null;
    }
    return { runId, resumeToken, principalAs };
  }

  /**
   * The principal form this decider may signal as: itself when the wait names it, otherwise a Role
   * it holds that the wait allows. `null` means the wait admits nothing this decider has.
   */
  private async approverPrincipal(
    allowedPrincipals: readonly string[],
    principal: string
  ): Promise<string | null> {
    if (allowedPrincipals.includes(principal)) return principal;
    const held = await this.options.repo.rolesForPrincipal(principal);
    return allowedPrincipals.find((allowed) => held.includes(allowed)) ?? null;
  }
}

function pendingApprovalOf(row: ApprovalRow): PendingToolApproval {
  const payload = payloadOf(row);
  return {
    approvalId: row.id,
    toolCallId: payload.toolCallId ?? "unknown-tool-call",
    toolName: payload.toolName ?? "unknown-tool",
    args: payload.args,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
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
