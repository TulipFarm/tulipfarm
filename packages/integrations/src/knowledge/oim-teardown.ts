import type { OimKnowledgeConnectionScope } from "./oim-sync";

export interface OimKnowledgeTeardownDeps {
  readonly publications: {
    tombstoneConnection(
      input: OimKnowledgeConnectionScope & {
        readonly deletedRevisionPrefix: string;
        readonly deletedAt: string;
      }
    ): Promise<readonly string[]>;
  };
  readonly checkpoints: {
    clearConnection(scope: OimKnowledgeConnectionScope): Promise<number>;
  };
  readonly now: () => Date;
  readonly newId: () => string;
}

export interface OimKnowledgeTeardownResult {
  readonly tombstonedSourceIds: readonly string[];
  readonly checkpoints: number;
}

export type OimKnowledgeTeardownPhase = "tombstone" | "checkpoint_cleanup";

export class OimKnowledgeTeardownError extends Error {
  readonly name = "OimKnowledgeTeardownError";
  readonly retryable = true;

  constructor(
    readonly phase: OimKnowledgeTeardownPhase,
    options?: ErrorOptions
  ) {
    super(`oim_knowledge_teardown_failed:${phase}`, options);
  }
}

/**
 * Removes one exact Connection's Knowledge. Source tombstones come first so deleting retry state
 * can never leave readable content behind after a partial uninstall.
 */
export async function teardownOimKnowledge(
  scope: OimKnowledgeConnectionScope,
  deps: OimKnowledgeTeardownDeps
): Promise<OimKnowledgeTeardownResult> {
  let tombstonedSourceIds: readonly string[];
  try {
    tombstonedSourceIds = await deps.publications.tombstoneConnection({
      ...scope,
      deletedRevisionPrefix: `deleted:${deps.newId()}`,
      deletedAt: deps.now().toISOString(),
    });
  } catch (cause) {
    throw new OimKnowledgeTeardownError("tombstone", { cause });
  }
  let checkpoints: number;
  try {
    checkpoints = await deps.checkpoints.clearConnection(scope);
  } catch (cause) {
    throw new OimKnowledgeTeardownError("checkpoint_cleanup", { cause });
  }
  return { tombstonedSourceIds, checkpoints };
}
