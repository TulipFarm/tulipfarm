import type { RunLeaseStore } from "@tulipfarm/run-kernel";
import type {
  PersistedRun,
  PersistedRunStatus,
  PersistedState,
  PersistedStateStatus,
  RunTransitionInput,
  StateTransitionInput,
} from "@tulipfarm/storage";
import type { ChatRunLifecycleStore } from "../runtime/chat-run-lifecycle";

export const FAKE_BUSINESS_ID = "tulipfarm-local";
export const FAKE_RUN_ID = "00000000-0000-4000-8000-000000000001";

/**
 * In-memory stand-in for the `runs` / `run_states` rows a chat invocation writes, with the same
 * compare-and-swap guard the real UPDATE applies. A fake that always succeeds would prove nothing
 * about lost races, which is the whole point of the lease.
 */
export class FakeRunStore implements RunLeaseStore, ChatRunLifecycleStore {
  run: PersistedRun = {
    id: FAKE_RUN_ID,
    businessId: FAKE_BUSINESS_ID,
    bundle: { digest: "published:agent:assistant", routineId: "chat", routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "user", id: "user-1" },
      guardrailContextRef: "identity:user",
    },
    bounds: { wallTimeMs: 3_600_000, activeTimeMs: 900_000, attempts: 3, sideEffects: 100 },
    status: "queued",
    version: 0,
    createdAt: "2026-07-27T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    resultArtifactId: null,
    errorEvidenceRef: null,
    leaseOwner: null,
    leaseExpiresAt: null,
  };

  state: PersistedState | null = {
    businessId: FAKE_BUSINESS_ID,
    runId: FAKE_RUN_ID,
    key: "invoke",
    definitionRef: "published:agent:assistant",
    resolvedInput: { payloadRef: "artifact:request:req-1" },
    status: "pending",
    version: 0,
    createdAt: "2026-07-27T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    resultArtifactId: null,
    errorEvidenceRef: null,
  };

  readonly runStatuses: PersistedRunStatus[] = [];
  readonly stateStatuses: PersistedStateStatus[] = [];

  async find(_businessId: string, runId: string): Promise<PersistedRun | null> {
    return runId === this.run.id ? this.run : null;
  }

  async findState(): Promise<PersistedState | null> {
    return this.state;
  }

  async transitionRun(
    _businessId: string,
    _runId: string,
    transition: RunTransitionInput
  ): Promise<boolean> {
    if (
      this.run.version !== transition.expectedVersion ||
      this.run.status !== transition.expectedStatus
    ) {
      return false;
    }
    this.run = {
      ...this.run,
      status: transition.status,
      version: this.run.version + 1,
      leaseOwner: transition.leaseOwner,
      leaseExpiresAt: transition.leaseExpiresAt,
      finishedAt: transition.finishedAt ?? this.run.finishedAt,
    };
    this.runStatuses.push(transition.status);
    return true;
  }

  async transitionState(
    _businessId: string,
    _runId: string,
    _stateKey: string,
    transition: StateTransitionInput
  ): Promise<boolean> {
    const state = this.state;
    if (
      !state ||
      state.version !== transition.expectedVersion ||
      state.status !== transition.expectedStatus
    ) {
      return false;
    }
    this.state = {
      ...state,
      status: transition.status,
      version: state.version + 1,
      startedAt: transition.startedAt ?? state.startedAt,
      finishedAt: transition.finishedAt ?? state.finishedAt,
    };
    this.stateStatuses.push(transition.status);
    return true;
  }

  async heartbeat(): Promise<boolean> {
    return true;
  }

  async reclaimExpiredRuns(): Promise<readonly PersistedRun[]> {
    return [];
  }

  async claimNextQueued(): Promise<readonly PersistedRun[]> {
    return [];
  }
}
