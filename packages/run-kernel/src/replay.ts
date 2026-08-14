import type { JsonObject } from "./outputs";
import type { CompiledRoutine } from "./routine/compiler";
import { type SimulationFixture, type SimulationResult, simulateRoutine } from "./simulate";

/**
 * Replay is simulation by default; live replay needs explicit grant and a fresh effect identity.
 */

export type ReplayErrorCode =
  | "live_replay_not_authorized"
  | "replay_not_eligible"
  | "stale_effect_identity";

/** A replay denial. Carries only `code:runId` — never recorded payload or identity material. */
export class ReplayError extends Error {
  constructor(
    readonly code: ReplayErrorCode,
    readonly subject: string
  ) {
    super(`${code}:${subject}`);
    this.name = "ReplayError";
  }
}

export const LIVE_REPLAY_GRANT = "run:replay:live";

/** How old an effect identity may be and still be considered fresh for a live replay. */
export const MAX_EFFECT_IDENTITY_AGE_MS = 15 * 60_000;

export type RecordedRunStatus = "cancelled" | "failed" | "running" | "succeeded";

const REPLAYABLE: ReadonlySet<RecordedRunStatus> = new Set(["cancelled", "failed", "succeeded"]);

export interface RecordedStep {
  readonly stateName: string;
  readonly outputHash: string;
}

export interface RecordedRun {
  readonly runId: string;
  readonly status: RecordedRunStatus;
  readonly routine: {
    readonly slug: string;
    readonly authoredVersion: number;
    readonly digest: string;
  };
  readonly fixture: SimulationFixture;
  readonly steps: readonly RecordedStep[];
}

export interface ReplayEffectIdentity {
  readonly principalKind: string;
  readonly principalId: string;
  readonly issuedAtMs: number;
}

export interface ReplayAuthorization {
  readonly grants: readonly string[];
  readonly approvedByPrincipalId: string;
  readonly effectIdentity: ReplayEffectIdentity;
}

export interface ReplayRequest {
  readonly mode?: "live" | "simulation";
  readonly authorization?: ReplayAuthorization;
}

export type SimulationDiffChange = "added" | "output_changed" | "removed";

export interface SimulationDiff {
  readonly identical: boolean;
  readonly states: readonly {
    readonly stateName: string;
    readonly change: SimulationDiffChange;
  }[];
}

export type ReplayPlan =
  | {
      readonly mode: "simulation";
      readonly sourceRunId: string;
      readonly dispatch: false;
      readonly routineChanged: boolean;
      readonly result: SimulationResult;
      readonly diff: SimulationDiff;
    }
  | {
      readonly mode: "live";
      readonly sourceRunId: string;
      readonly dispatch: true;
      readonly routineChanged: boolean;
      readonly effectIdentity: ReplayEffectIdentity;
      readonly approvedByPrincipalId: string;
      readonly input: JsonObject;
      readonly trigger: JsonObject;
    };

/** Recorded order is authoritative for `removed`, `added`, and `output_changed` diffs. */
export function diffSimulation(
  recorded: readonly RecordedStep[],
  candidate: SimulationResult
): SimulationDiff {
  const simulated = new Map(candidate.steps.map((step) => [step.stateName, step.outputHash]));
  const states: { stateName: string; change: SimulationDiffChange }[] = [];

  for (const step of recorded) {
    const hash = simulated.get(step.stateName);
    if (hash === undefined) {
      states.push({ stateName: step.stateName, change: "removed" });
      continue;
    }
    if (hash !== step.outputHash) {
      states.push({ stateName: step.stateName, change: "output_changed" });
    }
  }

  const seen = new Set(recorded.map((step) => step.stateName));
  for (const step of candidate.steps) {
    if (!seen.has(step.stateName)) states.push({ stateName: step.stateName, change: "added" });
  }

  return { identical: states.length === 0, states };
}

export function planReplay(
  recorded: RecordedRun,
  routine: CompiledRoutine,
  request: ReplayRequest,
  nowMs: number
): ReplayPlan {
  if (!REPLAYABLE.has(recorded.status)) {
    throw new ReplayError("replay_not_eligible", recorded.runId);
  }

  const routineChanged = routine.digest !== recorded.routine.digest;

  if (request.mode !== "live") {
    const result = simulateRoutine(routine, recorded.fixture);
    return {
      mode: "simulation",
      sourceRunId: recorded.runId,
      dispatch: false,
      routineChanged,
      result,
      diff: diffSimulation(recorded.steps, result),
    };
  }

  const authorization = request.authorization;
  if (authorization === undefined || !authorization.grants.includes(LIVE_REPLAY_GRANT)) {
    throw new ReplayError("live_replay_not_authorized", recorded.runId);
  }
  const { issuedAtMs } = authorization.effectIdentity;
  if (issuedAtMs > nowMs || nowMs - issuedAtMs > MAX_EFFECT_IDENTITY_AGE_MS) {
    throw new ReplayError("stale_effect_identity", recorded.runId);
  }

  return {
    mode: "live",
    sourceRunId: recorded.runId,
    dispatch: true,
    routineChanged,
    effectIdentity: authorization.effectIdentity,
    approvedByPrincipalId: authorization.approvedByPrincipalId,
    input: recorded.fixture.input ?? {},
    trigger: recorded.fixture.trigger ?? {},
  };
}
