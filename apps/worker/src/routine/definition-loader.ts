import { routine } from "@tulipfarm/schema";
import type { PinnedDefinition, PinnedDefinitionLoader } from "@tulipfarm/soul";
import type { PersistedRun } from "@tulipfarm/storage";

export type RoutineDefinitionLoadErrorCode =
  | "invalid_routine_definition"
  | "non_routine_run"
  | "pinned_routine_unavailable"
  | "unpublished_routine";

/** Payload-safe refusal to execute a Run whose exact Routine cannot be proved. */
export class RoutineDefinitionLoadError extends Error {
  readonly name = "RoutineDefinitionLoadError";

  constructor(
    readonly code: RoutineDefinitionLoadErrorCode,
    readonly runId: string
  ) {
    super(`${code}:${runId}`);
  }
}

type ExactDefinitionReader = Pick<PinnedDefinitionLoader, "load">;

export interface LoadedRoutineDefinition extends PinnedDefinition {
  readonly document: Readonly<routine.RoutineDefinition>;
}

/**
 * Maps a claimed Routine Run onto its exact signed Soul definition.
 *
 * This adapter deliberately has no active-publication or Git port. A Run that waited through a
 * newer publication resumes against the same digest, id, and authored version it started with.
 */
export class WorkerRoutineDefinitionLoader {
  constructor(private readonly definitions: ExactDefinitionReader) {}

  async load(run: PersistedRun): Promise<LoadedRoutineDefinition> {
    if (run.source !== "routine") {
      throw new RoutineDefinitionLoadError("non_routine_run", run.id);
    }

    const authoredVersion = Number(run.bundle.routineVersion);
    if (!Number.isSafeInteger(authoredVersion)) {
      throw new RoutineDefinitionLoadError("pinned_routine_unavailable", run.id);
    }
    const pinned = await this.definitions.load({
      businessId: run.businessId,
      bundleDigest: run.bundle.digest,
      kind: "Routine",
      definitionId: run.bundle.routineId,
      authoredVersion,
    });
    if (pinned === undefined) {
      throw new RoutineDefinitionLoadError("pinned_routine_unavailable", run.id);
    }

    let document: Readonly<routine.RoutineDefinition>;
    try {
      document = routine.validateRoutineDefinition(pinned.definition.document).document;
    } catch {
      throw new RoutineDefinitionLoadError("invalid_routine_definition", run.id);
    }
    if (document.metadata.lifecycle !== "published") {
      throw new RoutineDefinitionLoadError("unpublished_routine", run.id);
    }

    return { ...pinned, document };
  }
}
