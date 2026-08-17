import type { PersistedRun, PersistedRunStatus } from "@tulipfarm/storage";
import type { RunLeaseStore } from "../lease";
import type { ReconcilableStateStore } from "../reconcile-state";
import type { RunResumeStore } from "../resume";

const BUSINESS_ID = "business-1";
const RUN_ID = "00000000-0000-4000-8000-000000000001";

/** Failure injected at a durable write boundary; distinct from a real defect. */
export class SimulatedCrash extends Error {
  readonly name = "SimulatedCrash";

  constructor(
    readonly operation: string,
    readonly when: "before" | "after"
  ) {
    super(`simulated_crash:${when}:${operation}`);
  }
}

export interface SimulatedState {
  status: string;
  version: number;
  finishedAt: string | null;
  errorEvidenceRef: string | null;
}

function baseRun(overrides: Partial<PersistedRun>): PersistedRun {
  return {
    id: RUN_ID,
    businessId: BUSINESS_ID,
    source: "routine",
    bundle: { digest: "sha256:bundle-1", routineId: "routine-1", routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "agent", id: "agent-1" },
      guardrailContextRef: "guardrail-context-1",
    },
    status: "queued",
    version: 0,
    createdAt: "2026-07-25T09:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    resultArtifactId: null,
    errorEvidenceRef: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

/**
 * In-memory store with CAS, owner heartbeats, lease reclaim, and write-boundary crash injection;
 * both `crashBefore` and `crashAfter` must recover without a second commit.
 */
export class SimulatedRunStore implements RunLeaseStore, RunResumeStore, ReconcilableStateStore {
  private readonly runs = new Map<string, PersistedRun>();
  private readonly states = new Map<string, SimulatedState>();
  private readonly crashesBefore = new Set<string>();
  private readonly crashesAfter = new Set<string>();

  readonly transitions: Array<{ runId: string; from: string; to: string; version: number }> = [];
  requeues = 0;

  seedRun(overrides: Partial<PersistedRun> = {}): PersistedRun {
    const run = baseRun(overrides);
    this.runs.set(run.id, run);
    return run;
  }

  seedState(stateKey: string, state: { status: string; version: number }): void {
    this.states.set(stateKey, {
      status: state.status,
      version: state.version,
      finishedAt: null,
      errorEvidenceRef: null,
    });
  }

  stateOf(stateKey: string): SimulatedState | undefined {
    return this.states.get(stateKey);
  }

  crashBefore(operation: string): void {
    this.crashesBefore.add(operation);
  }

  crashAfter(operation: string): void {
    this.crashesAfter.add(operation);
  }

  private guard(operation: string, when: "before" | "after"): void {
    const crashes = when === "before" ? this.crashesBefore : this.crashesAfter;
    if (!crashes.delete(operation)) return;
    throw new SimulatedCrash(operation, when);
  }

  async transitionRun(
    _businessId: string,
    runId: string,
    transition: {
      expectedVersion: number;
      expectedStatus: PersistedRunStatus;
      status: PersistedRunStatus;
      leaseOwner: string | null;
      leaseExpiresAt: string | null;
    }
  ): Promise<boolean> {
    this.guard("transitionRun", "before");
    const run = this.runs.get(runId);
    if (
      !run ||
      run.status !== transition.expectedStatus ||
      run.version !== transition.expectedVersion
    ) {
      return false;
    }
    this.runs.set(runId, {
      ...run,
      status: transition.status,
      version: run.version + 1,
      leaseOwner: transition.leaseOwner,
      leaseExpiresAt: transition.leaseExpiresAt,
    });
    this.transitions.push({
      runId,
      from: run.status,
      to: transition.status,
      version: run.version + 1,
    });
    this.guard("transitionRun", "after");
    return true;
  }

  async heartbeat(
    _businessId: string,
    runId: string,
    owner: string,
    heartbeat: { expectedVersion: number; leaseExpiresAt: string }
  ): Promise<boolean> {
    this.guard("heartbeat", "before");
    const run = this.runs.get(runId);
    if (!run || run.leaseOwner !== owner || run.version !== heartbeat.expectedVersion) return false;
    this.runs.set(runId, { ...run, leaseExpiresAt: heartbeat.leaseExpiresAt });
    this.guard("heartbeat", "after");
    return true;
  }

  async reclaimExpiredRuns(
    _businessId: string,
    now: string,
    limit: number
  ): Promise<readonly PersistedRun[]> {
    this.guard("reclaimExpiredRuns", "before");
    const reclaimed: PersistedRun[] = [];
    for (const run of this.runs.values()) {
      if (reclaimed.length >= limit) break;
      const leased = run.status === "claimed" || run.status === "running";
      if (!leased || run.leaseExpiresAt === null || run.leaseExpiresAt > now) continue;
      const requeued: PersistedRun = {
        ...run,
        status: "queued",
        version: run.version + 1,
        leaseOwner: null,
        leaseExpiresAt: null,
      };
      this.runs.set(run.id, requeued);
      this.transitions.push({
        runId: run.id,
        from: run.status,
        to: "queued",
        version: requeued.version,
      });
      reclaimed.push(requeued);
    }
    this.guard("reclaimExpiredRuns", "after");
    return reclaimed;
  }

  async claimNextQueued(
    _businessId: string,
    owner: string,
    input: { now: string; leaseDurationMs: number; limit: number }
  ): Promise<readonly PersistedRun[]> {
    this.guard("claimNextQueued", "before");
    const claimed: PersistedRun[] = [];
    const leaseExpiresAt = new Date(
      new Date(input.now).getTime() + input.leaseDurationMs
    ).toISOString();
    for (const run of this.runs.values()) {
      if (claimed.length >= input.limit) break;
      if (run.status !== "queued") continue;
      const next: PersistedRun = {
        ...run,
        status: "claimed",
        version: run.version + 1,
        leaseOwner: owner,
        leaseExpiresAt,
      };
      this.runs.set(run.id, next);
      this.transitions.push({
        runId: run.id,
        from: "queued",
        to: "claimed",
        version: next.version,
      });
      claimed.push(next);
    }
    this.guard("claimNextQueued", "after");
    return claimed;
  }

  async find(_businessId: string, runId: string): Promise<PersistedRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async requeueWaitingRun(_businessId: string, runId: string): Promise<boolean> {
    this.guard("requeueWaitingRun", "before");
    const run = this.runs.get(runId);
    if (run?.status !== "waiting") return false;
    this.runs.set(runId, { ...run, status: "queued", version: run.version + 1 });
    this.requeues += 1;
    this.guard("requeueWaitingRun", "after");
    return true;
  }

  async findState(
    _businessId: string,
    _runId: string,
    stateKey: string
  ): Promise<{ status: string; version: number } | null> {
    const state = this.states.get(stateKey);
    return state ? { status: state.status, version: state.version } : null;
  }

  async transitionState(
    _businessId: string,
    _runId: string,
    stateKey: string,
    transition: {
      expectedVersion: number;
      expectedStatus: string;
      status: string;
      finishedAt?: string;
      errorEvidenceRef?: string;
    }
  ): Promise<boolean> {
    this.guard("transitionState", "before");
    const state = this.states.get(stateKey);
    if (
      !state ||
      state.status !== transition.expectedStatus ||
      state.version !== transition.expectedVersion
    ) {
      return false;
    }
    this.states.set(stateKey, {
      status: transition.status,
      version: state.version + 1,
      finishedAt: transition.finishedAt ?? null,
      errorEvidenceRef: transition.errorEvidenceRef ?? null,
    });
    this.guard("transitionState", "after");
    return true;
  }
}
