import type { RegisterWaitInput } from "@tulipfarm/run-kernel";
import type { InternalApiClient } from "../internal/client";

/** Approval waits are planned here, but resume tokens never cross into the worker. */

export type RoutineApprovalDecision = "pending" | "approved" | "denied" | "expired";

export interface RoutineApprovalRecord {
  readonly approvalId: string;
  readonly waitId: string;
  readonly decision: RoutineApprovalDecision;
}

export interface RoutineApprovalPort {
  /**
   * Open the approval for this State occurrence, or return the one it is already parked on.
   *
   * Idempotent by occurrence: a worker that died between opening the approval and parking the
   * State replays into its own approval rather than asking a second human.
   */
  open(input: {
    businessId: string;
    runId: string;
    stateKey: string;
    stateName: string;
    wait: RegisterWaitInput;
  }): Promise<RoutineApprovalRecord>;

  /** The decision this State occurrence's approval carries, if it has one open. */
  find(input: {
    businessId: string;
    runId: string;
    stateKey: string;
  }): Promise<RoutineApprovalRecord | undefined>;
}

/** Drop business/Run ids from the body; the host derives them from the route's Run. */
function waitPlan(wait: RegisterWaitInput): Omit<RegisterWaitInput, "businessId" | "runId"> {
  return {
    id: wait.id,
    stateKey: wait.stateKey,
    kind: wait.kind,
    aggregation: wait.aggregation,
    schemaRef: wait.schemaRef,
    allowedPrincipals: wait.allowedPrincipals,
    expectedSignals: wait.expectedSignals,
    quorum: wait.quorum,
    deadlineAt: wait.deadlineAt,
    createdAt: wait.createdAt,
  };
}

/** The `/api/v1/internal/runs/:runId/routine-approvals` implementation of the port. */
export class HttpRoutineApprovalPort implements RoutineApprovalPort {
  constructor(private readonly client: InternalApiClient) {}

  async open(input: {
    businessId: string;
    runId: string;
    stateKey: string;
    stateName: string;
    wait: RegisterWaitInput;
  }): Promise<RoutineApprovalRecord> {
    return this.client.require<RoutineApprovalRecord>(
      "POST",
      `/api/v1/internal/runs/${encodeURIComponent(input.runId)}/routine-approvals`,
      { stateKey: input.stateKey, stateName: input.stateName, wait: waitPlan(input.wait) }
    );
  }

  async find(input: {
    businessId: string;
    runId: string;
    stateKey: string;
  }): Promise<RoutineApprovalRecord | undefined> {
    // Only `204` means no approval; `404` is a dead Run and must stay an error.
    return this.client.find<RoutineApprovalRecord>(
      "GET",
      `/api/v1/internal/runs/${encodeURIComponent(input.runId)}/routine-approvals?stateKey=${encodeURIComponent(input.stateKey)}`,
      [204]
    );
  }
}
