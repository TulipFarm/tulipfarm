import type { RegisterWaitInput } from "@tulipfarm/run-kernel";
import type { InternalApiClient } from "../internal/client";

/**
 * What a Routine `approval` State parks on.
 *
 * The wait is planned here — the deadline, the approver roles, and the schema reference are
 * authored on the State, and the run-kernel is where authored semantics live — but it is
 * *registered* on the other side of this port. A wait's resume token is the capability to resume
 * that Run once, and the process that redeems it is the one holding the decision surface, so it
 * must never travel here. This side learns only the wait's id and, later, the decision.
 */

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

/**
 * The plan as the host takes it. Which business and which Run the wait belongs to are the route's
 * to state from the Run itself, so sending them here would be a claim this side is not entitled to
 * make — and the host refuses a body carrying them.
 */
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
    // `204` is the only absence: this occurrence has no approval open. A `404` is a Run that is
    // gone and must stay an error, or a replay would read "no decision yet" from a dead Run.
    return this.client.find<RoutineApprovalRecord>(
      "GET",
      `/api/v1/internal/runs/${encodeURIComponent(input.runId)}/routine-approvals?stateKey=${encodeURIComponent(input.stateKey)}`,
      [204]
    );
  }
}
