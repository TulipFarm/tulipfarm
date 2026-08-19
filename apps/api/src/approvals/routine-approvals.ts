import { randomUUID } from "node:crypto";
import { DurableWaitError, type DurableWaitManager } from "@tulipfarm/run-kernel";
import { canonicalHash } from "@tulipfarm/schema";
import {
  type ApprovalRow,
  type ApprovalSignalOutcome,
  type ApprovalsRepo,
  listPendingRoutineApprovals,
} from "@tulipfarm/tool-host";
import type { RoutineApprovalPayload } from "../internal/routine-approval-host";

/** SPEC §7.2 approval decisions are durable wait signals; roles are user-role grants only. */

/** The roles a deciding principal actually holds, canonicalized to the wait's principal form. */
export function rolePrincipals(roles: readonly string[]): readonly string[] {
  return roles.map((role) => `role:${role}`);
}

export interface RoutineApprovalServiceOptions {
  readonly repo: ApprovalsRepo;
  readonly waits: DurableWaitManager;
  newId?(): string;
  now?(): Date;
}

function payloadOf(row: { payload: unknown }): Partial<RoutineApprovalPayload> {
  return typeof row.payload === "object" && row.payload !== null
    ? (row.payload as Partial<RoutineApprovalPayload>)
    : {};
}

export class RoutineApprovalService {
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(private readonly options: RoutineApprovalServiceOptions) {
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  /** Pending approvals the caller's roles are allowed to decide. */
  async listPendingFor(input: {
    businessId: string;
    roles: readonly string[];
  }): Promise<ApprovalRow[]> {
    return await listPendingRoutineApprovals(this.options.repo, this.options.waits, input);
  }

  /** Write the decision before resuming; check the role before settling the row. */
  async signal(input: {
    businessId: string;
    approvalId: string;
    decision: "approved" | "denied";
    /** Who is deciding, for the audit trail and for the kernel's own principal check. */
    principal: string;
    /** Every role that principal holds; membership in one the wait allows is what authorizes. */
    roles: readonly string[];
  }): Promise<ApprovalSignalOutcome> {
    const row = await this.options.repo.findById(input.approvalId);
    if (row === null || row.kind !== "routine_state") return "not_found";
    const { waitId, runId, resumeToken } = payloadOf(row);
    if (waitId === undefined || runId === undefined || resumeToken === undefined) {
      return "not_found";
    }

    const wait = await this.options.waits.find(input.businessId, waitId);
    if (wait === null) return "not_found";
    const held = new Set(rolePrincipals(input.roles));
    const asRole = wait.allowedPrincipals.find((allowed) => held.has(allowed));
    if (asRole === undefined) return "forbidden";

    if (!(await this.options.repo.settlePending(input.approvalId, input.decision))) {
      return "already_settled";
    }

    try {
      await this.options.waits.signal({
        id: this.newId(),
        businessId: input.businessId,
        runId,
        token: resumeToken,
        // The wait authorizes the role; the evidence records the person who exercised it.
        principal: asRole,
        // A decision must declare the wait's schema, not this process's local signal shape.
        schemaRef: wait.schemaRef,
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
      // A raced or swept wait must not turn a settled approval into a failed request.
      if (!(error instanceof DurableWaitError)) throw error;
      return "already_settled";
    }
    return "resumed";
  }
}
