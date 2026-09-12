import type { OimConnection, OimOperation } from "@tulipfarm/schema";
import type { PersistedConnection } from "@tulipfarm/storage";

export interface ConnectionPrincipal {
  readonly kind: string;
  readonly id: string;
}

export interface ConnectionReader {
  findById(businessId: string, id: string): Promise<PersistedConnection | null>;
  listForOwner(
    businessId: string,
    integration: OimConnection["integration"],
    owner: OimConnection["owner"]
  ): Promise<PersistedConnection[]>;
  listForIntegration(
    businessId: string,
    integration: OimConnection["integration"]
  ): Promise<PersistedConnection[]>;
}

export interface ConnectionUseAuthorizer {
  canUse(principal: ConnectionPrincipal, connection: PersistedConnection): Promise<boolean>;
}

export interface ConnectionSummary {
  readonly id: string;
  readonly integration: OimConnection["integration"];
  readonly label: string;
  readonly ownerScope: OimConnection["owner"]["scope"];
  readonly isDefault: boolean;
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  readonly health: OimConnection["health"];
  readonly expiresAt: string | null;
}

export type ConnectionResolution =
  | { readonly kind: "selected"; readonly connection: PersistedConnection }
  | {
      readonly kind: "selection_required";
      readonly reason: "missing" | "no_default" | "ambiguous";
      readonly candidates: readonly ConnectionSummary[];
    }
  | {
      readonly kind: "denied";
      readonly reason: "not_found" | "not_authorized" | "inactive" | "identity_mode";
    };

export interface ConnectionResolutionRequest {
  readonly businessId: string;
  readonly integration: OimConnection["integration"];
  readonly identityMode: OimOperation["identityMode"];
  readonly principal: ConnectionPrincipal;
  readonly personalOwnerId?: string;
  readonly connectionId?: string;
  readonly requireExplicitConnection?: boolean;
}

function supportsOwner(
  identityMode: OimOperation["identityMode"],
  ownerScope: OimConnection["owner"]["scope"]
): boolean {
  if (identityMode === "personal_required") return ownerScope === "personal";
  if (identityMode === "shared_only") return ownerScope !== "personal";
  return true;
}

function safeSummary(connection: PersistedConnection): ConnectionSummary {
  return {
    id: connection.id,
    integration: connection.integration,
    label: connection.label,
    ownerScope: connection.owner.scope,
    isDefault: connection.isDefault,
    configuration: Object.fromEntries(
      connection.agentVisibleConfiguration.flatMap((key) => {
        const value = connection.configuration[key];
        return value === undefined ? [] : [[key, value]];
      })
    ),
    health: connection.health,
    expiresAt: connection.expiresAt,
  };
}

function matchesIntegration(
  connection: PersistedConnection,
  integration: OimConnection["integration"]
): boolean {
  return (
    connection.integration.id === integration.id &&
    connection.integration.majorVersion === integration.majorVersion
  );
}

function isPersonalOwner(connection: PersistedConnection, principalId: string | undefined) {
  return (
    connection.owner.scope === "personal" &&
    principalId !== undefined &&
    connection.owner.principalId === principalId
  );
}

export class ConnectionResolver {
  constructor(
    private readonly connections: ConnectionReader,
    private readonly authorizer: ConnectionUseAuthorizer
  ) {}

  async resolve(request: ConnectionResolutionRequest): Promise<ConnectionResolution> {
    if (
      request.personalOwnerId !== undefined &&
      (request.principal.kind !== "user" || request.personalOwnerId !== request.principal.id)
    ) {
      return { kind: "denied", reason: "not_authorized" };
    }
    if (request.connectionId !== undefined) {
      return this.resolveExact(request, request.connectionId);
    }

    const candidates = await this.authorizedCandidates(request);
    if (request.requireExplicitConnection === true) {
      return this.selectionRequired(candidates);
    }

    const personalDefaults =
      request.identityMode === "shared_only"
        ? []
        : candidates.filter((row) => row.owner.scope === "personal" && row.isDefault);
    const personalDefault = personalDefaults[0];
    if (personalDefaults.length === 1 && personalDefault !== undefined) {
      return { kind: "selected", connection: personalDefault };
    }
    if (personalDefaults.length > 1) return this.selectionRequired(candidates);

    const sharedDefaults =
      request.identityMode === "personal_required"
        ? []
        : candidates.filter((row) => row.owner.scope !== "personal" && row.isDefault);
    const sharedDefault = sharedDefaults[0];
    if (sharedDefaults.length === 1 && sharedDefault !== undefined) {
      return { kind: "selected", connection: sharedDefault };
    }
    return this.selectionRequired(candidates);
  }

  private selectionRequired(candidates: readonly PersistedConnection[]): ConnectionResolution {
    const summaries = candidates.map(safeSummary);
    return {
      kind: "selection_required",
      reason:
        summaries.length === 0 ? "missing" : summaries.length === 1 ? "no_default" : "ambiguous",
      candidates: summaries,
    };
  }

  private async resolveExact(
    request: ConnectionResolutionRequest,
    connectionId: string
  ): Promise<ConnectionResolution> {
    const connection = await this.connections.findById(request.businessId, connectionId);
    if (
      connection === null ||
      connection.businessId !== request.businessId ||
      !matchesIntegration(connection, request.integration)
    ) {
      return { kind: "denied", reason: "not_found" };
    }
    if (
      connection.owner.scope === "personal" &&
      !isPersonalOwner(connection, request.personalOwnerId)
    ) {
      return { kind: "denied", reason: "not_authorized" };
    }
    if (!(await this.authorizer.canUse(request.principal, connection))) {
      return { kind: "denied", reason: "not_authorized" };
    }
    if (connection.status !== "active") return { kind: "denied", reason: "inactive" };
    if (!supportsOwner(request.identityMode, connection.owner.scope)) {
      return { kind: "denied", reason: "identity_mode" };
    }
    return { kind: "selected", connection };
  }

  private async authorizedCandidates(
    request: ConnectionResolutionRequest
  ): Promise<PersistedConnection[]> {
    const lists: Promise<PersistedConnection[]>[] = [];
    if (request.identityMode !== "shared_only" && request.personalOwnerId !== undefined) {
      lists.push(
        this.connections.listForOwner(request.businessId, request.integration, {
          scope: "personal",
          principalKind: "user",
          principalId: request.personalOwnerId,
        })
      );
    }
    if (request.identityMode !== "personal_required") {
      lists.push(
        this.connections.listForOwner(request.businessId, request.integration, {
          scope: "organization",
        }),
        this.connections.listForIntegration(request.businessId, request.integration)
      );
    }

    const candidates = (await Promise.all(lists))
      .flat()
      .filter(
        (connection, index, all) =>
          all.findIndex((candidate) => candidate.id === connection.id) === index
      )
      .filter(
        (connection) =>
          connection.businessId === request.businessId &&
          connection.status === "active" &&
          matchesIntegration(connection, request.integration) &&
          supportsOwner(request.identityMode, connection.owner.scope) &&
          (connection.owner.scope !== "personal" ||
            isPersonalOwner(connection, request.personalOwnerId))
      );
    const authorized: PersistedConnection[] = [];
    for (const connection of candidates) {
      if (await this.authorizer.canUse(request.principal, connection)) authorized.push(connection);
    }
    return authorized;
  }
}
