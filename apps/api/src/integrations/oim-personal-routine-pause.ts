import { definitions } from "@tulipfarm/schema";
import type { RoutineCatalog, SoulWriter } from "@tulipfarm/soul";
import type { AssetOwnershipRepo } from "@tulipfarm/storage";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../runtime/soul-writer";

export interface PausePersonalRoutinesInput {
  readonly businessId: string;
  readonly userId: string;
}

export type PausePersonalRoutines = (input: PausePersonalRoutinesInput) => Promise<void>;

export interface OimPersonalRoutinePauseDeps {
  readonly businessId: string;
  readonly routines: Pick<RoutineCatalog, "list">;
  readonly ownership: Pick<AssetOwnershipRepo, "get">;
  readonly soulWriter: Pick<SoulWriter, "readWithBase" | "apply">;
  readonly onRoutinesChanged: () => Promise<void>;
}

function failuresFrom(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) => {
    if (result.status === "fulfilled") return [];
    return result.reason instanceof AggregateError ? result.reason.errors : [result.reason];
  });
}

class CommittedRoutinePauseError extends Error {}

/**
 * Retires published personal Routines after their exact user owner is disabled.
 *
 * Team ownership is checked against both the current Routine document and its durable ownership
 * projection. Either shared signal keeps the Routine live.
 */
export class OimPersonalRoutinePause {
  constructor(private readonly deps: OimPersonalRoutinePauseDeps) {}

  readonly pausePersonalRoutines: PausePersonalRoutines = async (input) => {
    if (input.businessId !== this.deps.businessId) {
      throw new Error(`Personal Routine pause refused business ${input.businessId}`);
    }

    const principal = `user:${input.userId}`;
    const candidates = (await this.deps.routines.list()).filter(
      (routine) => routine.summary.owner === principal
    );
    if (candidates.length === 0) return;

    const results: PromiseSettledResult<unknown>[] = [];
    let refreshRequired = false;
    for (const candidate of candidates) {
      try {
        refreshRequired =
          (await this.pauseRoutine(input.businessId, candidate.slug, principal)) || refreshRequired;
        results.push({ status: "fulfilled", value: undefined });
      } catch (reason) {
        if (reason instanceof CommittedRoutinePauseError) refreshRequired = true;
        results.push({ status: "rejected", reason });
      }
    }
    if (refreshRequired) {
      results.push(
        await this.deps.onRoutinesChanged().then(
          (value) => ({ status: "fulfilled", value }),
          (reason: unknown) => ({ status: "rejected", reason })
        )
      );
    }

    const failures = failuresFrom(results);
    if (failures.length > 0) {
      throw new AggregateError(failures, "personal Routine pause did not complete");
    }
  };

  private async pauseRoutine(
    businessId: string,
    slug: string,
    principal: string
  ): Promise<boolean> {
    const { content, baseCommit } = await this.deps.soulWriter.readWithBase("Routine", slug);
    if (content === null) return false;

    const routine = definitions.routine.validateRoutineDefinition(parseYaml(content)).document;
    if (routine.spec.owner !== principal || routine.spec.ownership !== undefined) return false;

    const durableOwnership = await this.deps.ownership.get(
      businessId,
      "routine",
      routine.metadata.id
    );
    if (durableOwnership !== undefined) return false;
    if (routine.metadata.lifecycle === "retired") return true;

    const metadata = {
      ...routine.metadata,
      authoredVersion: routine.metadata.authoredVersion + 1,
      lifecycle: "retired" as const,
    };
    delete metadata.publishedDigest;

    const result = await this.deps.soulWriter.apply({
      subject: `soul: pause personal routine ${slug}`,
      source: "api",
      actor: SYSTEM_SOUL_COMMIT_ACTOR,
      businessId,
      changes: [
        {
          op: "put",
          target: { kind: "Routine", slug },
          content: stringifyYaml({ ...routine, metadata }),
        },
      ],
      preconditions: [{ kind: "Routine", slug, state: "present" }],
      expectedBaseCommit: baseCommit,
    });
    if (!result.published) {
      throw new CommittedRoutinePauseError(`Personal Routine ${slug} pause was not published`);
    }
    return true;
  }
}
