import {
  DISPATCH_HANDLER_ERROR_REF,
  DISPATCH_LEASE_EXPIRED_REF,
  DISPATCH_REQUEUED_ONCE_REF,
  DISPATCH_UNSPECIFIED_PARK_REF,
  type PersistedRun,
} from "@tulipfarm/storage";

export interface RecoveryEffect {
  readonly runId: string;
  readonly stateId: string;
  readonly state: string;
  readonly outputStored: boolean;
  readonly output?: unknown;
}

export interface RecoveryEffectReader {
  list(businessId: string): Promise<readonly RecoveryEffect[]>;
}

export interface TargetedRunRecoveryStore {
  find(businessId: string, runId: string): Promise<PersistedRun | null>;
  listRecoveryCandidates(businessId: string, limit: number): Promise<readonly PersistedRun[]>;
  requeueParkedRun(
    businessId: string,
    runId: string,
    expectedVersion: number,
    expectedEvidenceRef: string | null
  ): Promise<PersistedRun | null>;
}

export type RunRecoveryResult =
  | { readonly outcome: "requeued"; readonly run: PersistedRun }
  | { readonly outcome: "already_requeued"; readonly run: PersistedRun }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "version_conflict"; readonly run: PersistedRun }
  | {
      readonly outcome: "terminal";
      readonly status: "succeeded" | "failed" | "cancelled";
      readonly run: PersistedRun;
    }
  | { readonly outcome: "needs_reconciliation"; readonly run: PersistedRun }
  | { readonly outcome: "unsupported"; readonly run: PersistedRun };

const RECOVERABLE_EVIDENCE: ReadonlySet<string> = new Set([
  DISPATCH_HANDLER_ERROR_REF,
  DISPATCH_LEASE_EXPIRED_REF,
  DISPATCH_UNSPECIFIED_PARK_REF,
]);

const REPLAY_SAFE_EFFECT_STATES: ReadonlySet<string> = new Set([
  "proposed",
  "denied",
  "awaiting_approval",
  "authorized",
  "failed",
  "compensated",
]);

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

function hasChildReplayDescriptor(effect: RecoveryEffect): boolean {
  if (!effect.outputStored || effect.output === null || typeof effect.output !== "object") {
    return false;
  }
  const output = effect.output as Record<string, unknown>;
  return (
    output.kind === "child_park" &&
    typeof output.childRunId === "string" &&
    output.childRunId.length > 0 &&
    typeof output.waitId === "string" &&
    output.waitId.length > 0
  );
}

function effectsNeedReconciliation(effects: readonly RecoveryEffect[]): boolean {
  // Unknown states stay parked. Recovery must prove replay safety rather than infer it.
  return effects.some((effect) => {
    if (effect.state === "authorized") {
      return effect.outputStored && !hasChildReplayDescriptor(effect);
    }
    if (effect.state === "awaiting_child" || effect.state === "dispatched") {
      return !hasChildReplayDescriptor(effect);
    }
    return (
      !REPLAY_SAFE_EFFECT_STATES.has(effect.state) &&
      !(effect.state === "confirmed" && effect.outputStored)
    );
  });
}

/** Requeues abandoned work only when every durable effect has a replay-safe outcome. */
export class RunRecoveryManager {
  constructor(
    private readonly runs: TargetedRunRecoveryStore,
    private readonly effects: RecoveryEffectReader
  ) {}

  async reconcile(input: {
    businessId: string;
    runId: string;
    expectedVersion: number;
  }): Promise<RunRecoveryResult> {
    const current = await this.runs.find(input.businessId, input.runId);
    if (current === null) return { outcome: "not_found" };
    if (TERMINAL_RUN_STATUSES.has(current.status)) {
      return {
        outcome: "terminal",
        status: current.status as "succeeded" | "failed" | "cancelled",
        run: current,
      };
    }
    if (current.status === "queued" && current.errorEvidenceRef === DISPATCH_REQUEUED_ONCE_REF) {
      return { outcome: "already_requeued", run: current };
    }
    if (current.version !== input.expectedVersion) {
      return { outcome: "version_conflict", run: current };
    }
    // A NULL errorEvidenceRef is itself a recoverable case: it is how a Run parked before
    // evidence-ref stamping existed (or by any future return path that forgets to name a reason)
    // still surfaces here instead of being permanently unsupported.
    if (
      current.status !== "needs_reconciliation" ||
      (current.errorEvidenceRef !== null && !RECOVERABLE_EVIDENCE.has(current.errorEvidenceRef))
    ) {
      return { outcome: "unsupported", run: current };
    }

    const effects = (await this.effects.list(input.businessId)).filter(
      (effect) => effect.runId === input.runId
    );
    if (effectsNeedReconciliation(effects)) {
      return { outcome: "needs_reconciliation", run: current };
    }

    const requeued = await this.runs.requeueParkedRun(
      input.businessId,
      input.runId,
      input.expectedVersion,
      current.errorEvidenceRef
    );
    if (requeued !== null) return { outcome: "requeued", run: requeued };
    const raced = await this.runs.find(input.businessId, input.runId);
    return raced === null ? { outcome: "not_found" } : { outcome: "version_conflict", run: raced };
  }

  async sweep(input: {
    businessId: string;
    limit: number;
  }): Promise<{ examined: number; requeued: number; needsReconciliation: number }> {
    const candidates = await this.runs.listRecoveryCandidates(input.businessId, input.limit);
    let requeued = 0;
    let needsReconciliation = 0;
    for (const run of candidates) {
      const result = await this.reconcile({
        businessId: input.businessId,
        runId: run.id,
        expectedVersion: run.version,
      });
      if (result.outcome === "requeued" || result.outcome === "already_requeued") requeued += 1;
      if (result.outcome === "needs_reconciliation" || result.outcome === "unsupported") {
        needsReconciliation += 1;
      }
    }
    return { examined: candidates.length, requeued, needsReconciliation };
  }
}
