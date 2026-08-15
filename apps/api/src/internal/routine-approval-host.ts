import {
  DurableWaitManager,
  type RegisterWaitInput,
  type RunResumeGateway,
} from "@tulipfarm/run-kernel";
import { WaitStore } from "@tulipfarm/storage";
import { type ApprovalRow, ApprovalsRepo } from "@tulipfarm/tool-host";
import { ambientTransactionPort, type Queryable } from "../db";
import type { HostedRunReader } from "./turn-host";

/**
 * Routine approval host: persists approval and wait in one transaction.
 * Resume tokens never leave the process that will redeem them; route identity names the Run.
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

/** `expired` is distinct from `denied`; authored State paths can handle them differently. */
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
  /** Kernel-planned wait, including deterministic id; route owns business and Run identity. */
  readonly wait: Omit<RegisterWaitInput, "businessId" | "runId">;
}

/** Payload stored on a `routine_state` approval row for list and decision reads. */
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

  /** Idempotent by State occurrence, so replayed parks find their existing approval. */
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
