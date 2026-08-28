import {
  CHILD_COMPLETION_SCHEMA_REF,
  type ChildLink,
  type ChildLinkAncestry,
  type ChildLinkStore,
  ChildRunManager,
  type RegisteredWait,
  type RegisterWaitInput,
  routineWaitId,
} from "@tulipfarm/run-kernel";
import type { PersistedWait } from "@tulipfarm/storage";
import type { HostedRunReader } from "./turn-host";

/**
 * Child-Routine host: mints the Run a `child_routine` State calls, and — in `wait` mode — the
 * durable wait its completion resumes the caller through.
 *
 * The Worker cannot do this itself: the invocation gateway mints the child's Run id, so the wait
 * that names the child as its only allowed principal can only be composed after the child exists.
 */

/** How deep a Routine-calls-Routine chain may go before a further call is refused. */
export const CHILD_ROUTINE_MAX_DEPTH = 5;

export type ChildRoutineDenial =
  | "run_not_found"
  | "run_not_running"
  | "not_a_routine"
  | "depth_limit_exceeded"
  | "deadline_not_bounded";

export class ChildRoutineDeniedError extends Error {
  readonly name = "ChildRoutineDeniedError";

  constructor(readonly code: ChildRoutineDenial) {
    super(code);
  }
}

/** The Run source a Routine is minted under; anything else has no `child_routine` State to run. */
const ROUTINE_SOURCE = "routine";

/** A Run may only be operated on while an executor holds it. */
const OPERABLE_RUN_STATUS = "running";

const TERMINAL_RUN_STATUS: Readonly<Record<string, ChildRoutineStatus>> = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * A child Routine is a published definition whose authority was reviewed when it was authored, so
 * its link records lineage only. Depth, cancellation and audit still follow it; the child's own
 * States are not intersected with the caller's grants.
 */
const LINEAGE_AUTHORITY = { tools: [], classifications: [], limits: {} } as const;

export type ChildRoutineStatus = "pending" | "succeeded" | "failed" | "cancelled" | "expired";

export interface ChildRoutineRecord {
  readonly childRunId: string;
  readonly status: ChildRoutineStatus;
  /** The wait the caller is parked on; `null` in `detach` mode and once the child has settled. */
  readonly waitId: string | null;
}

export interface StartChildRoutineInput {
  /** Durable State occurrence key — the fan-out unit included, so each iteration calls once. */
  readonly stateKey: string;
  /** Authored State name, for attribution on the child Run. */
  readonly stateName: string;
  readonly routineRef: { readonly name: string; readonly version: string };
  readonly mode: "wait" | "detach";
  readonly input: Record<string, unknown>;
  /**
   * How long the caller may stay parked before the wait times out. Required in `wait` mode and
   * refused when absent, so a Routine can never park on a child forever; `detach` never parks.
   */
  readonly deadlineMs?: number;
}

/** Mints the child Routine's Run. Returns the gateway-assigned Run id. */
export type ChildRoutineStarter = (input: {
  readonly slug: string;
  readonly inputs: Record<string, unknown>;
  readonly identity: { readonly kind: string; readonly id: string };
  readonly idempotencyKey: string;
}) => Promise<{ readonly runId: string }>;

/** The slice of `DurableWaitManager` this host needs. */
export interface ChildRoutineWaitPort {
  register(input: RegisterWaitInput): Promise<RegisteredWait>;
  find(businessId: string, waitId: string): Promise<PersistedWait | null>;
}

export interface InternalChildRoutineHostOptions {
  readonly runs: HostedRunReader;
  readonly links: ChildLinkStore;
  readonly ancestry: ChildLinkAncestry;
  readonly waits: ChildRoutineWaitPort;
  readonly start: ChildRoutineStarter;
  readonly maxDepth?: number;
  now?(): Date;
}

export class InternalChildRoutineHost {
  private readonly now: () => Date;
  private readonly children: ChildRunManager;
  private readonly maxDepth: number;

  constructor(private readonly options: InternalChildRoutineHostOptions) {
    this.now = options.now ?? (() => new Date());
    this.children = new ChildRunManager(options.links, options.ancestry);
    this.maxDepth = options.maxDepth ?? CHILD_ROUTINE_MAX_DEPTH;
  }

  /** Idempotent by State occurrence: a replayed State adopts its own child, never a second one. */
  async start(
    businessId: string,
    runId: string,
    input: StartChildRoutineInput
  ): Promise<ChildRoutineRecord> {
    const parent = await this.authorize(businessId, runId);
    // Checked before anything is minted: a caller that cannot be parked must not leave a child
    // Run behind that nothing will ever read the answer of.
    const deadlineMs = input.mode === "detach" ? null : this.boundedDeadline(input.deadlineMs);

    const existing = await this.options.ancestry.callLink?.(businessId, runId, input.stateKey);
    if (existing) return this.report(businessId, existing);

    // Read from the persisted chain, so a child cannot restart the count by asking again.
    const chain = await this.children.ancestors(businessId, runId, this.maxDepth);
    if (chain.length + 1 > this.maxDepth) {
      throw new ChildRoutineDeniedError("depth_limit_exceeded");
    }

    const startedAt = this.now();
    const child = await this.options.start({
      slug: input.routineRef.name,
      inputs: input.input,
      identity: {
        kind: parent.identity.effectiveSubject.kind,
        id: parent.identity.effectiveSubject.id,
      },
      // Derived from the caller's State occurrence, so a retried start adopts the same child Run.
      idempotencyKey: `child_routine:${runId}:${input.stateKey}`,
    });

    // Registered before the link, so the grant the child's completion reads back already exists.
    const resume =
      deadlineMs === null
        ? undefined
        : await this.registerWait(
            businessId,
            runId,
            child.runId,
            input.stateKey,
            deadlineMs,
            startedAt
          );

    const link = await this.children.spawn({
      businessId,
      parentRunId: runId,
      childRunId: child.runId,
      parentAuthority: LINEAGE_AUTHORITY,
      requestedAuthority: {},
      authorityBinding: "lineage",
      ...(resume === undefined ? {} : { resume }),
      callId: input.stateKey,
      // A detached child outlives its caller, so it is written closed rather than opened and then
      // closed: an open link is one a cancel cascade can reach and a crash can leave behind.
      ...(input.mode === "detach" ? { detached: true } : {}),
      now: startedAt.toISOString(),
    });

    // It stays for depth and audit, but the caller is never resumed by it and cancelling the
    // caller does not cascade into it.
    if (input.mode === "detach") {
      return { childRunId: child.runId, status: "pending", waitId: null };
    }

    // The child is claimable from the moment it is minted, so it can settle before its link — and
    // therefore its resume grant — is durable. Re-reading closes that window: a child that has
    // already finished is answered now rather than parked on a signal nobody could receive.
    return this.report(businessId, link);
  }

  /** The child this State occurrence called, and what it has come to, if it called one. */
  async find(
    businessId: string,
    runId: string,
    stateKey: string
  ): Promise<ChildRoutineRecord | undefined> {
    await this.authorize(businessId, runId);
    const link = await this.options.ancestry.callLink?.(businessId, runId, stateKey);
    if (!link) return undefined;
    return this.report(businessId, link);
  }

  private async registerWait(
    businessId: string,
    runId: string,
    childRunId: string,
    stateKey: string,
    deadlineMs: number,
    startedAt: Date
  ): Promise<{ waitId: string; token: string }> {
    const registered = await this.options.waits.register({
      // Deterministic in the caller's State occurrence, so a replayed start finds its own wait.
      id: routineWaitId(runId, stateKey),
      businessId,
      runId,
      stateKey,
      kind: "child_run",
      aggregation: "first",
      // Pinned: `signalChildCompletion` always delivers this ref, and a mismatch is `wrong_schema`.
      schemaRef: CHILD_COMPLETION_SCHEMA_REF,
      allowedPrincipals: [`run:${childRunId}`],
      expectedSignals: 1,
      quorum: null,
      deadlineAt: new Date(startedAt.getTime() + deadlineMs).toISOString(),
      createdAt: startedAt.toISOString(),
    });
    return { waitId: registered.wait.id, token: registered.token };
  }

  private boundedDeadline(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new ChildRoutineDeniedError("deadline_not_bounded");
    }
    return value;
  }

  /**
   * What the caller should do about this child now.
   *
   * The child Run is asked first: a settled child is an answer whatever its wait says. Only a
   * child still in flight can have been overtaken by its own deadline.
   */
  private async report(businessId: string, link: ChildLink): Promise<ChildRoutineRecord> {
    const child = await this.options.runs.find(businessId, link.childRunId);
    const settled = child === null ? undefined : TERMINAL_RUN_STATUS[child.status];
    if (settled !== undefined) {
      return { childRunId: link.childRunId, status: settled, waitId: null };
    }

    const waitId = link.resume?.waitId ?? null;
    if (waitId === null) return { childRunId: link.childRunId, status: "pending", waitId: null };

    const wait = await this.options.waits.find(businessId, waitId);
    return {
      childRunId: link.childRunId,
      status: wait?.status === "timed_out" ? "expired" : "pending",
      waitId,
    };
  }

  /** The Run calling a child, refusing any Run no executor may write for. */
  private async authorize(businessId: string, runId: string) {
    const run = await this.options.runs.find(businessId, runId);
    if (run === null) throw new ChildRoutineDeniedError("run_not_found");
    if (run.status !== OPERABLE_RUN_STATUS) throw new ChildRoutineDeniedError("run_not_running");
    if (run.source !== ROUTINE_SOURCE) throw new ChildRoutineDeniedError("not_a_routine");
    return run;
  }
}
