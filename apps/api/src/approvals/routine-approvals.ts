import { randomUUID } from "node:crypto";
import { DurableWaitError, type DurableWaitManager } from "@tulipfarm/run-kernel";
import { canonicalHash } from "@tulipfarm/schema";
import type { RoutineApprovalPayload } from "../internal/routine-approval-host";
import type { ApprovalsRepo } from "./runtime-repo";
import type { ApprovalSignalOutcome } from "./tool-approvals";

/**
 * Deciding a Routine State's approval (SPEC §7.2).
 *
 * The shape is the Tool approval's, for the same reason: the Run is parked on a durable kernel
 * wait holding no lease, so a decision is a signal that requeues that Run in whichever process
 * picks it up — never a call into the executor. What differs is *who may decide*. A Tool approval
 * belongs to the person the turn acts as; a Routine State names **roles** on the State itself, so
 * the wait allows `role:<role>` principals and a decider is authorized by the roles they hold.
 *
 * The deployment's only role authority today is the user's own recorded role, so an authored
 * `approverRoles` naming anything else has no members and the decision is refused. That is the
 * fail-closed reading: an approval nobody can be shown to hold the role for is not one to accept
 * on trust.
 */

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

  /**
   * Records a human decision on a Routine State and resumes the Run.
   *
   * Row first, wait second, exactly as a Tool approval: the settled row is what the replayed State
   * reads, so a Run that woke before it was written would park all over again. And the role check
   * runs before the row is settled — the kernel checks the principal again under the wait's lock
   * and is the authority, but a decision the wait would then refuse must not leave the approval
   * settled and the Run parked until its deadline.
   */
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
      // Not a Worker-parked Routine approval — the caller falls through to the path that owns it.
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
        // The State authored what its approval is, so the wait's own schema reference is the one a
        // decision must declare — not this process's idea of what an approval signal looks like.
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
      // The decision is recorded either way — a wait already resolved by the deadline sweep, or by
      // a racing decision, must not turn a settled approval into a failed request.
      if (!(error instanceof DurableWaitError)) throw error;
      return "already_settled";
    }
    return "resumed";
  }
}
