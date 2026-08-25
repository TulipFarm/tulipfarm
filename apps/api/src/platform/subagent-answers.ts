import type { SubagentAnswerReader } from "@tulipfarm/agent-runtime";
import { type ArtifactService, RUN_EXECUTOR_PRINCIPAL_REF } from "@tulipfarm/run-kernel";
import type { SubagentAnswer } from "@tulipfarm/schema";
import type { RunStore } from "@tulipfarm/storage";

/** Mirrors `subagentAnswerArtifactId` in the Worker; the two must name the same Artifact. */
export function subagentAnswerArtifactId(runId: string): string {
  return `${runId}:answer`;
}

const TERMINAL_FAILURES: ReadonlySet<string> = new Set([
  "failed",
  "start_failed",
  "cancelled",
  "needs_reconciliation",
]);

export interface SubagentAnswerDeps {
  readonly runs: Pick<RunStore, "find">;
  readonly artifacts: Pick<ArtifactService, "read">;
  now?(): Date;
}

/**
 * Reads a sub-agent's outcome from its Run status and its answer Artifact.
 *
 * The Run's status decides whether it finished; the Artifact carries what it said. Those are two
 * records rather than one because a Run can fail after producing nothing, and reading only the
 * Artifact would leave such a helper looking merely slow — the parent would park forever on a
 * child that is never going to answer.
 */
export function subagentAnswers(deps: SubagentAnswerDeps): SubagentAnswerReader {
  const now = deps.now ?? (() => new Date());
  return {
    read: async (businessId, childRunId) => {
      const run = await deps.runs.find(businessId, childRunId);
      if (run === null) return { status: "failed", answer: null };
      if (TERMINAL_FAILURES.has(run.status)) return { status: "failed", answer: null };
      if (run.status !== "succeeded") return { status: null, answer: null };

      try {
        const artifact = await deps.artifacts.read({
          businessId,
          artifactId: subagentAnswerArtifactId(childRunId),
          reader: RUN_EXECUTOR_PRINCIPAL_REF,
          allowedClassifications: [],
          now: now(),
        });
        return {
          status: "succeeded",
          answer: (artifact.content as unknown as SubagentAnswer).answer,
        };
      } catch {
        // Succeeded but published nothing: the Run reached the end without an answer, which the
        // parent must be told about rather than left waiting on.
        return { status: "failed", answer: null };
      }
    },
  };
}
