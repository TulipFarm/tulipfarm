import { definitions } from "@tulipfarm/schema";
import type { RuntimeBundle } from "@tulipfarm/soul";
import type { AssetOwnershipRepo } from "@tulipfarm/storage";

const PERSONAL_OWNER_PATTERN =
  /^user:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export type RoutineOwnerEligibility =
  | {
      readonly status: "allowed";
      readonly ownership: "personal" | "organization" | "team";
    }
  | {
      readonly status: "denied";
      readonly reason: "personal_owner_disabled" | "personal_owner_missing";
    }
  | { readonly status: "unavailable" };

export interface RoutineOwnerAuthorityHostDeps {
  readonly businessId: string;
  readonly runs: {
    find(
      businessId: string,
      runId: string
    ): Promise<{
      readonly businessId: string;
      readonly source: string;
      readonly bundle: {
        readonly digest: string;
        readonly routineId: string;
        readonly routineVersion: string;
      };
    } | null>;
  };
  readonly bundles: {
    load(businessId: string, digest: string): Promise<RuntimeBundle | undefined>;
  };
  readonly ownership: Pick<AssetOwnershipRepo, "get">;
  readonly users: {
    findById(id: string): Promise<{ readonly status: string } | null>;
  };
}

/** Fresh owner eligibility for a pinned Routine Run. The caller supplies only its Run id. */
export class RoutineOwnerAuthorityHost {
  constructor(private readonly deps: RoutineOwnerAuthorityHostDeps) {}

  async checkRoutineOwner(input: { readonly runId: string }): Promise<RoutineOwnerEligibility> {
    try {
      const run = await this.deps.runs.find(this.deps.businessId, input.runId);
      if (run === null || run.businessId !== this.deps.businessId || run.source !== "routine") {
        return { status: "unavailable" };
      }

      const bundle = await this.deps.bundles.load(run.businessId, run.bundle.digest);
      if (
        bundle === undefined ||
        bundle.businessId !== run.businessId ||
        bundle.digest !== run.bundle.digest
      ) {
        return { status: "unavailable" };
      }

      const definition = bundle.getById(run.bundle.routineId);
      if (
        definition === undefined ||
        definition.kind !== "Routine" ||
        String(definition.authoredVersion) !== run.bundle.routineVersion
      ) {
        return { status: "unavailable" };
      }

      const routine = definitions.routine.validateRoutineDefinition(definition.document).document;
      if (
        routine.metadata.id !== run.bundle.routineId ||
        String(routine.metadata.authoredVersion) !== run.bundle.routineVersion ||
        routine.metadata.lifecycle !== "published"
      ) {
        return { status: "unavailable" };
      }

      const ownership = await this.deps.ownership.get(
        run.businessId,
        "routine",
        run.bundle.routineId
      );
      if (ownership !== undefined) {
        return ownership.owners.some((owner) => owner.kind === "team")
          ? { status: "allowed", ownership: "team" }
          : { status: "unavailable" };
      }
      if (routine.spec.ownership !== undefined) return { status: "unavailable" };

      if (!routine.spec.owner.startsWith("user:")) {
        return { status: "allowed", ownership: "organization" };
      }

      const userId = PERSONAL_OWNER_PATTERN.exec(routine.spec.owner)?.[1];
      if (userId === undefined) return { status: "unavailable" };
      const user = await this.deps.users.findById(userId);
      if (user === null) {
        return { status: "denied", reason: "personal_owner_missing" };
      }
      if (user.status !== "active") {
        return { status: "denied", reason: "personal_owner_disabled" };
      }
      return { status: "allowed", ownership: "personal" };
    } catch {
      return { status: "unavailable" };
    }
  }
}
