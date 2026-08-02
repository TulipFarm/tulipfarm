import { randomUUID } from "node:crypto";
import type { InvocationPrincipal } from "@tulipfarm/run-kernel";
import { DurableWaitError, type DurableWaitManager } from "@tulipfarm/run-kernel";
import { canonicalHash } from "@tulipfarm/schema";
import type { ApprovalRow, ApprovalsRepo } from "./runtime-repo";

/**
 * Tool approvals as durable Run waits (plan §5; blocker §2).
 *
 * The Worker executes turns, so an approval can no longer be a promise a request handler awaits:
 * the process holding it may not be the process that resumes. What survives instead is a row and a
 * kernel wait — the Run parks in `waiting` holding no lease, a human decides whenever they get to
 * it, and the wait's resolution requeues **that same Run**. Nothing about the decision depends on
 * either process still being alive.
 *
 * Two identities do the work. An approval is keyed by the *intent* — this Run, this Tool, these
 * arguments — because the resumed loop re-proposes the call under a new call id, and matching on
 * the call id would ask the human twice for one decision. The wait is keyed by its one-use resume
 * token, which is what makes a replayed decision a no-op rather than a second resume.
 */

/** The schema every approval signal declares. Identity only — a decision carries no payload. */
export const APPROVAL_SIGNAL_SCHEMA_REF = "tulipfarm.approval.decision.v1";

/**
 * How long an approval stays open.
 *
 * A day, not the five minutes the in-process gate used: that timeout existed because a suspended
 * HTTP handler could not be held longer, and a durable wait has no such limit. What bounds it now
 * is the human — an approval nobody looked at within a day is one the Run should stop waiting for.
 */
export const APPROVAL_WAIT_TTL_MS = 24 * 60 * 60_000;

/** What the dispatcher does with a Tool call that needs a human. */
export type ToolApprovalDecision =
  | { readonly status: "approved" }
  | { readonly status: "denied"; readonly reason: string }
  | { readonly status: "pending"; readonly approvalId: string };

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
      return { status: "approved" };
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

export class ToolApprovalService {
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(private readonly options: ToolApprovalServiceOptions) {
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? APPROVAL_WAIT_TTL_MS;
  }

  /**
   * The standing decision for one Tool intent, requesting one when none exists.
   *
   * Called on every dispatch of a gated call, including the one the resumed loop re-proposes. That
   * is the whole point: the second time round the row is already settled, so the same code path
   * that asked for the approval is the one that honours it — there is no separate "resume" branch
   * that could disagree with the first.
   */
  async decide(input: {
    businessId: string;
    runId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
  }): Promise<ToolApprovalDecision> {
    const intentDigest = intentOf(input.runId, input.toolName, input.args);
    const existing = await this.options.repo.findByIntent(input.runId, intentDigest);
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
   * Parks the Run on a durable wait for an approval already requested.
   *
   * Separate from `decide` because a request is not a park: the loop may still fail, be cancelled,
   * or be superseded between proposing the call and stopping on it, and a wait registered for a Run
   * that never parked would be a resume nothing is waiting for. Registering is idempotent — a
   * redelivered park redeems the wait the Run is already on rather than minting a second one.
   *
   * The resume token is stored beside the approval it belongs to. It is a capability to resume this
   * one Run once, never returned to a client and never placed in an event; the wait itself holds
   * only its digest, so redemption is still single-use and still checked against the principal.
   */
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

  /**
   * Records a human decision and resumes the Run.
   *
   * The row is settled first and the wait signalled second, and the order matters: the settled row
   * is what the resumed dispatch reads, so a Run that woke before it was written would re-propose
   * the call and park all over again.
   *
   * Which is also why the principal is checked *before* the row is settled. The kernel checks it
   * again under the wait's lock and is the authority — but a decision recorded by someone the wait
   * then refuses would leave the approval settled and the Run parked until its deadline.
   */
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

/**
 * What a human is actually being asked about: this Run calling this Tool with these arguments.
 *
 * Not the call id. The Worker's loop resumes by re-assembling the Context and letting the model
 * propose again, so the approved call comes back wearing a new call id — keyed by that, every
 * resume would ask the same question again and the Run could never proceed.
 */
export function intentOf(runId: string, toolName: string, args: unknown): string {
  return canonicalHash({ runId, toolName, args: args ?? null });
}
