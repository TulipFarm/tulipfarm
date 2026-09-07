import type { ConnectionUseAuthorizer } from "@tulipfarm/integrations";
import { definitions } from "@tulipfarm/schema";
import type { BundleVerifier, SoulPublicationCoordinator } from "@tulipfarm/soul";
import type { AssetOwnershipRepo } from "@tulipfarm/storage";
import type { RoutineConnectionUseAuthorizer } from "./oim-trigger-authorization";

interface ActiveRoutineConnectionUseAuthorizerDeps {
  readonly publications: Pick<SoulPublicationCoordinator, "activeBundle">;
  readonly verifier: BundleVerifier;
  readonly ownership: Pick<AssetOwnershipRepo, "get">;
  readonly users: {
    findById(id: string): Promise<{ readonly status: string } | null>;
  };
  readonly teams: {
    getTeam(businessId: string, teamId: string): Promise<{ readonly status: string } | undefined>;
  };
  readonly organizationConnectionAccess: ConnectionUseAuthorizer;
}

function personalOwner(owner: string): string | undefined {
  const prefix = "user:";
  if (!owner.startsWith(prefix)) return undefined;
  const id = owner.slice(prefix.length);
  return id.length === 0 ? undefined : id;
}

/**
 * Resolves the exact published Routine and checks its current durable owner against a Connection.
 *
 * The original author and Trigger payload have no authority here. Team ownership comes from the
 * durable asset projection, while organization access requires a live grant to the Routine.
 */
export class ActiveRoutineConnectionUseAuthorizer implements RoutineConnectionUseAuthorizer {
  constructor(private readonly deps: ActiveRoutineConnectionUseAuthorizerDeps) {}

  async canUse(input: Parameters<RoutineConnectionUseAuthorizer["canUse"]>[0]): Promise<boolean> {
    try {
      if (
        input.connection.businessId !== input.businessId ||
        input.connection.status !== "active"
      ) {
        return false;
      }
      const bundle = await this.deps.publications.activeBundle(
        input.businessId,
        this.deps.verifier
      );
      const definition = bundle?.get("Routine", input.routineRef.name);
      if (
        bundle === undefined ||
        bundle.businessId !== input.businessId ||
        definition === undefined ||
        String(definition.authoredVersion) !== input.routineRef.version
      ) {
        return false;
      }

      const routine = definitions.routine.validateRoutineDefinition(definition.document).document;
      if (
        routine.metadata.id !== definition.id ||
        routine.metadata.lifecycle !== "published" ||
        String(routine.metadata.authoredVersion) !== input.routineRef.version
      ) {
        return false;
      }

      const ownership = await this.deps.ownership.get(
        input.businessId,
        "routine",
        routine.metadata.id
      );
      if (ownership === undefined && routine.spec.ownership !== undefined) return false;

      const personalOwnerId =
        ownership === undefined ? personalOwner(routine.spec.owner) : undefined;
      if (personalOwnerId !== undefined) {
        const user = await this.deps.users.findById(personalOwnerId);
        if (user?.status !== "active") return false;
      }

      if (input.connection.owner.scope === "personal") {
        return personalOwnerId === input.connection.owner.principalId;
      }

      if (input.connection.owner.scope === "team") {
        if (ownership === undefined) return false;
        const teamId = input.connection.owner.teamId;
        const ownsOrCanUse =
          ownership.owners.some((owner) => owner.kind === "team" && owner.teamId === teamId) ||
          ownership.shares.some(
            (share) =>
              share.teamId === teamId && (share.access === "use" || share.access === "edit")
          );
        if (!ownsOrCanUse) return false;
        const team = await this.deps.teams.getTeam(input.businessId, teamId);
        return team?.status === "active";
      }

      return await this.deps.organizationConnectionAccess.canUse(
        { kind: "routine", id: routine.metadata.id },
        input.connection
      );
    } catch {
      return false;
    }
  }
}
