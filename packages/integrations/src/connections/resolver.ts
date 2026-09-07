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
  /** The human whose personal Connection may be used by this caller after authorization. */
  readonly personalOwnerId?: string;
  /** Required for persistent automation. Omit only for live selection. */
  readonly connectionId?: string;
  /** Persistent callers set this so a mutable default can never choose their account. */
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
  const configuration = Object.fromEntries(
    connection.agentVisibleConfiguration.flatMap((key) => {
      const value = connection.configuration[key];
      return value === undefined ? [] : [[key, value]];
    })
  );
  return {
    id: connection.id,
    integration: connection.integration,
    label: connection.label,
    ownerScope: connection.owner.scope,
    isDefault: connection.isDefault,
    configuration,
    health: connection.health,
    expiresAt: connection.expiresAt,
  };
}

function belongsToIntegration(
  connection: PersistedConnection,
  integration: OimConnection["integration"]
): boolean {
  return (
    connection.integration.id === integration.id &&
    connection.integration.majorVersion === integration.majorVersion
  );
}

function isPersonalOwner(connection: PersistedConnection, personalOwnerId: string | undefined) {
  return (
    connection.owner.scope === "personal" &&
    personalOwnerId !== undefined &&
    connection.owner.principalId === personalOwnerId
  );
}

export class ConnectionResolver {
  constructor(
    private readonly connections: ConnectionReader,
    private readonly authorizer: ConnectionUseAuthorizer
  ) {}

  async resolve(request: ConnectionResolutionRequest): Promise<ConnectionResolution> {
    if (
      request.principal.kind === "user" &&
      request.personalOwnerId !== undefined &&
      request.personalOwnerId !== request.principal.id
    ) {
      return { kind: "denied", reason: "not_authorized" };
    }
    if (request.connectionId !== undefined) {
      return this.resolveExact(request, request.connectionId);
    }

    const candidates = await this.authorizedCandidates(request);
    if (request.requireExplicitConnection === true) {
      const summaries = candidates.map(safeSummary);
      return {
        kind: "selection_required",
        reason:
          summaries.length === 0 ? "missing" : summaries.length === 1 ? "no_default" : "ambiguous",
        candidates: summaries,
      };
    }
    const personal = candidates.filter((connection) => connection.owner.scope === "personal");
    const team = candidates.filter((connection) => connection.owner.scope === "team");
    const organization = candidates.filter(
      (connection) => connection.owner.scope === "organization"
    );

    const defaultResolution =
      request.identityMode === "shared_only"
        ? (this.defaultFrom(team) ?? this.defaultFrom(organization))
        : request.identityMode === "personal_required"
          ? this.defaultFrom(personal)
          : (this.defaultFrom(personal) ??
            this.defaultFrom(team) ??
            this.defaultFrom(organization));
    if (defaultResolution !== undefined) return defaultResolution;

    const summaries = candidates.map(safeSummary);
    if (summaries.length === 0) {
      return { kind: "selection_required", reason: "missing", candidates: [] };
    }
    return {
      kind: "selection_required",
      reason: summaries.length === 1 ? "no_default" : "ambiguous",
      candidates: summaries,
    };
  }

  /**
   * Rechecks the exact Connection an already-recorded effect intends to spend.
   *
   * Effects can wait for approval or retry after a provider failure. The original selection is not
   * authority to lease a credential later, after its owner revoked access or changed the binding.
   */
  async reauthorizeBinding(request: {
    readonly businessId: string;
    readonly integration: OimConnection["integration"];
    readonly connectionId: string;
    readonly credentialSlot: string;
    readonly credentialRef: `secret://${string}`;
    readonly principal: ConnectionPrincipal;
  }): Promise<boolean> {
    try {
      const connection = await this.connections.findById(request.businessId, request.connectionId);
      return (
        connection !== null &&
        connection.status === "active" &&
        belongsToIntegration(connection, request.integration) &&
        connection.secretBindings[request.credentialSlot] === request.credentialRef &&
        (await this.authorizer.canUse(request.principal, connection))
      );
    } catch {
      return false;
    }
  }

  private async resolveExact(
    request: ConnectionResolutionRequest,
    connectionId: string
  ): Promise<ConnectionResolution> {
    const connection = await this.connections.findById(request.businessId, connectionId);
    if (connection === null || !belongsToIntegration(connection, request.integration)) {
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
    if (connection.status !== "active") {
      return { kind: "denied", reason: "inactive" };
    }
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
        })
      );
      lists.push(this.connections.listForIntegration(request.businessId, request.integration));
    }

    const candidates = (await Promise.all(lists))
      .flat()
      .filter(
        (connection, index, all) =>
          all.findIndex((candidate) => candidate.id === connection.id) === index
      )
      .filter(
        (connection) =>
          connection.status === "active" &&
          belongsToIntegration(connection, request.integration) &&
          supportsOwner(request.identityMode, connection.owner.scope) &&
          (connection.owner.scope !== "personal" ||
            isPersonalOwner(connection, request.personalOwnerId))
      );
    const authorized: PersistedConnection[] = [];
    for (const connection of candidates) {
      if (await this.authorizer.canUse(request.principal, connection)) {
        authorized.push(connection);
      }
    }
    return authorized;
  }

  private defaultFrom(
    connections: readonly PersistedConnection[]
  ): ConnectionResolution | undefined {
    const defaults = connections.filter((connection) => connection.isDefault);
    if (defaults.length === 1) return { kind: "selected", connection: defaults[0] };
    if (defaults.length > 1) {
      return {
        kind: "selection_required",
        reason: "ambiguous",
        candidates: defaults.map(safeSummary),
      };
    }
    return undefined;
  }
}
