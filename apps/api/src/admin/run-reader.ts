import type { PersistedRun, PersistedState, RunLineage, RunStore } from "@tulipfarm/storage";
import type { RunReadModel, RunStateReadModel } from "./routes";

/** Reads Runs through `RunStore`; the API must not query storage-owned tables directly. */
export interface RunReader {
  list(
    businessId: string,
    options: { cursor?: string; limit: number }
  ): Promise<{ items: readonly RunReadModel[]; nextCursor: string | null }>;
  get(businessId: string, runId: string): Promise<RunReadModel | null>;
}

function stateReadModel(state: PersistedState, attempts: number): RunStateReadModel {
  return {
    key: state.key,
    status: state.status,
    attempts,
    input: state.resolvedInput,
    ...(state.resultArtifactId ? { output: { artifactId: state.resultArtifactId } } : {}),
    ...(state.errorEvidenceRef ? { errorEvidenceRef: state.errorEvidenceRef } : {}),
  };
}

function lineageReadModel(link: RunLineage): Record<string, unknown> {
  return {
    sourceRunId: link.sourceRunId,
    targetRunId: link.targetRunId,
    relation: link.relation,
    createdAt: link.createdAt,
  };
}

function runReadModel(
  run: PersistedRun,
  states: readonly RunStateReadModel[],
  lineage: readonly Record<string, unknown>[]
): RunReadModel {
  return {
    id: run.id,
    routineId: run.bundle.routineId,
    routineVersion: run.bundle.routineVersion,
    status: run.status,
    version: run.version,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    states,
    // Tool effects, waits, Guardrail decisions, and cost accounting have no writer until the
    // durable worker dispatches Runs. These are genuinely empty today, not withheld — the
    // inspector shows an empty section rather than an invented one.
    effects: [],
    waits: [],
    guardrailDecisions: [],
    lineage,
    costs: { amountUsd: 0, modelTokens: 0 },
  };
}

/** List pages omit per-Run detail to stay one round trip. */
export function createRunReader(runs: RunStore): RunReader {
  return {
    async list(businessId, options) {
      const page = await runs.list({
        businessId,
        limit: options.limit,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      });
      return {
        items: page.items.map((run) => runReadModel(run, [], [])),
        nextCursor: page.nextCursor,
      };
    },

    async get(businessId, runId) {
      const run = await runs.find(businessId, runId);
      if (!run) return null;
      const [states, attempts, lineage] = await Promise.all([
        runs.listStates(businessId, runId),
        runs.countStateAttempts(businessId, runId),
        runs.listLineage(businessId, runId),
      ]);
      return runReadModel(
        run,
        states.map((state) => stateReadModel(state, attempts.get(state.key) ?? 0)),
        lineage.map(lineageReadModel)
      );
    },
  };
}
