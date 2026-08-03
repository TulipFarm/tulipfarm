import {
  DurableWaitManager,
  type RegisterWaitInput,
  type RunResumeGateway,
} from "@tulipfarm/run-kernel";
import { WaitStore } from "@tulipfarm/storage";
import { type ApprovalRow, ApprovalsRepo } from "../approvals/runtime-repo";
import { ambientTransactionPort, type Queryable } from "../db";
import type { HostedRunReader } from "./turn-host";

/**
 * The internal Routine-approval host — what a Routine Run calls back into when a State needs a
 * human (SPEC §7.2, §9.2).
 *
 * The Worker plans the wait, because the deadline, the approver roles, and the schema reference
 * are authored on the State and the kernel is where authored semantics live. It does not register
 * it: a wait's resume token is the capability to resume that Run once, and it must never leave the
 * process that will redeem it. So the Worker sends the plan, this host persists the approval and
 * the wait **in one transaction**, and the Worker learns only the wait's id.
 *
 * The same rule as every other internal host governs it: the caller states which Run, never as
 * whom. The Run must exist, be `running`, and have been minted as a Routine — a worker credential
 * cannot open an approval against a chat turn, and the businessId and Run the wait is registered
 * for are the route's, not the caller's.
 */

export type RoutineApprovalDenial = "run_not_found" | "run_not_running" | "not_a_routine";

export class RoutineApprovalDeniedError extends Error {
  readonly name = "RoutineApprovalDeniedError";

  constructor(readonly code: RoutineApprovalDenial) {
    super(code);
  }
}

/** The Run source a Routine is minted under; anything else has no Routine State to approve. */
const ROUTINE_SOURCE = "routine";

/** A Run may only be operated on while an executor holds it. */
const OPERABLE_RUN_STATUS = "running";

/**
 * What a human decided, as the Worker must read it.
 *
 * `expired` is nobody's decision — the deadline passed with no answer — and is deliberately not
 * folded into `denied`: a State's authored paths treat a rejection and an expiry differently.
 */
export type RoutineApprovalDecision = "pending" | "approved" | "denied" | "expired";

export interface RoutineApprovalRecord {
  readonly approvalId: string;
  readonly waitId: string;
  readonly decision: RoutineApprovalDecision;
}

export interface OpenRoutineApprovalInput {
  /** Durable State occurrence key — what the approval is opened against, fan-out unit included. */
  readonly stateKey: string;
  /** Authored State name, for the reader deciding it. */
  readonly stateName: string;
  /**
   * The wait exactly as the kernel planned it, including its deterministic id. Which business and
   * which Run it belongs to are the route's to state, never the caller's.
   */
  readonly wait: Omit<RegisterWaitInput, "businessId" | "runId">;
}

/** Payload stored on a `routine_state` approval row; read by the approvals list and the decision. */
export interface RoutineApprovalPayload {
  readonly runId: string;
  readonly stateKey: string;
  readonly stateName: string;
  readonly routineId: string;
  readonly waitId: string;
  /** Capability to resume this one Run once. Never returned to any caller, never in an event. */
  readonly resumeToken: string;
}

export interface InternalRoutineApprovalHostOptions {
  readonly runs: HostedRunReader;
  /** Pool-backed handle for reads; `withTransaction` owns every write. */
  readonly db: Queryable;
  readonly withTransaction: <T>(operation: (tx: Queryable) => Promise<T>) => Promise<T>;
  /** Resumes the Run a resolved wait belongs to, once its approval is decided. */
  readonly resume: RunResumeGateway;
  now?(): Date;
}

export function routineApprovalPayload(row: ApprovalRow): Partial<RoutineApprovalPayload> {
  return typeof row.payload === "object" && row.payload !== null
    ? (row.payload as Partial<RoutineApprovalPayload>)
    : {};
}

/** A settled row reports its decision; a pending one past its deadline was decided by nobody. */
function decisionOf(row: ApprovalRow, now: Date): RoutineApprovalDecision {
  switch (row.status) {
    case "approved":
      return "approved";
    case "denied":
      return "denied";
    case "timeout":
      return "expired";
    default:
      return row.expiresAt <= now ? "expired" : "pending";
  }
}

export class InternalRoutineApprovalHost {
  private readonly now: () => Date;
  private readonly approvals: ApprovalsRepo;

  constructor(private readonly options: InternalRoutineApprovalHostOptions) {
    this.now = options.now ?? (() => new Date());
    this.approvals = new ApprovalsRepo(options.db);
  }

  /**
   * Opens the approval a Routine State parks on, or returns the one it is already parked on.
   *
   * Idempotent by State occurrence, which is what makes a replayed park safe: the Worker derives
   * the wait id from `(runId, stateKey)`, so a worker that died between opening the approval and
   * parking the State finds its own approval here instead of asking a second human.
   */
  async open(
    businessId: string,
    runId: string,
    input: OpenRoutineApprovalInput
  ): Promise<RoutineApprovalRecord> {
    const routineId = await this.authorize(businessId, runId);
    const existing = await this.lookup(runId, input.stateKey);
    if (existing !== undefined) return existing;

    // One commit for both writes. An approval row whose wait was never registered would be a
    // question nobody's answer could resume; a wait with no row would be a Run parked on a
    // decision no reader can see. Neither is allowed to exist.
    return this.options.withTransaction(async (tx) => {
      const waits = new DurableWaitManager(
        new WaitStore(ambientTransactionPort(tx)),
        this.options.resume
      );
      const registered = await waits.register({ ...input.wait, businessId, runId });
      const payload: RoutineApprovalPayload = {
        runId,
        stateKey: input.stateKey,
        stateName: input.stateName,
        routineId,
        waitId: registered.wait.id,
        resumeToken: registered.token,
      };
      await new ApprovalsRepo(tx).insert({
        id: registered.wait.id,
        kind: "routine_state",
        payload,
        expiresAt: new Date(input.wait.deadlineAt),
      });
      return { approvalId: registered.wait.id, waitId: registered.wait.id, decision: "pending" };
    });
  }

  /** The approval this State occurrence is parked on, whatever it was decided. */
  async find(
    businessId: string,
    runId: string,
    stateKey: string
  ): Promise<RoutineApprovalRecord | undefined> {
    await this.authorize(businessId, runId);
    return this.lookup(runId, stateKey);
  }

  private async lookup(
    runId: string,
    stateKey: string
  ): Promise<RoutineApprovalRecord | undefined> {
    const row = await this.approvals.findByRunState(runId, stateKey);
    const waitId = row === null ? undefined : routineApprovalPayload(row).waitId;
    if (row === null || waitId === undefined) return undefined;
    return { approvalId: row.id, waitId, decision: decisionOf(row, this.now()) };
  }

  /** The Routine this Run is executing, refusing any Run no executor may write for. */
  private async authorize(businessId: string, runId: string): Promise<string> {
    const run = await this.options.runs.find(businessId, runId);
    if (run === null) throw new RoutineApprovalDeniedError("run_not_found");
    if (run.status !== OPERABLE_RUN_STATUS) throw new RoutineApprovalDeniedError("run_not_running");
    if (run.source !== ROUTINE_SOURCE) throw new RoutineApprovalDeniedError("not_a_routine");
    return run.bundle.routineId;
  }
}
