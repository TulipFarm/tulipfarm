import {
  type OimManifest,
  type OimOperation,
  oimOriginPlaceholder,
  PATH_CREDENTIAL_PLACEHOLDER,
} from "@tulipfarm/schema";
import type { PersistedConnection } from "@tulipfarm/storage";
import type { ToolConnectionBinding } from "@tulipfarm/tool-broker";
import type {
  ConnectionPrincipal,
  ConnectionResolutionRequest,
  ConnectionResolver,
  ConnectionSummary,
} from "./resolver";

/** Reserved Tool input consumed by the host and never forwarded to a provider. */
export const OIM_CONNECTION_ID_ARGUMENT = "connection_id";

export interface OimOperationConnectionRequest {
  readonly businessId: string;
  readonly manifest: OimManifest;
  readonly operation: OimOperation;
  readonly principal: ConnectionPrincipal;
  readonly personalOwnerId?: string;
  readonly connectionId?: string;
  readonly requireExplicitConnection?: boolean;
}

export type OimOperationConnection =
  | { readonly kind: "public" }
  | { readonly kind: "configured"; readonly connection: PersistedConnection }
  | {
      readonly kind: "ready";
      readonly connection: PersistedConnection;
      readonly credentialRef: `secret://${string}`;
      readonly binding: ToolConnectionBinding;
      readonly secondaryCredentialRef?: `secret://${string}`;
      readonly secondaryBinding?: ToolConnectionBinding;
    }
  | {
      readonly kind: "connection_required" | "connection_ambiguous";
      readonly candidates: readonly ConnectionSummary[];
    }
  | {
      readonly kind: "connection_unhealthy";
      readonly connectionId: string;
      readonly status: PersistedConnection["health"]["status"] | "expired";
    }
  | {
      readonly kind: "credential_required";
      readonly connectionId: string;
      readonly credentialSlot: string;
    }
  | {
      readonly kind: "connection_denied";
      readonly reason: "not_found" | "not_authorized" | "inactive" | "identity_mode";
    };

function secretReference(value: string | undefined): value is `secret://${string}` {
  return value?.startsWith("secret://") === true && value.length > "secret://".length;
}

function requiresConfiguration(manifest: OimManifest, operation: OimOperation): boolean {
  const fields = new Set((manifest.auth?.configurationFields ?? []).map((field) => field.id));
  if (fields.size === 0) return false;
  const source = operation.source;
  if (
    ((source.type === "http" || source.type === "openapi") &&
      source.baseUrl !== undefined &&
      oimOriginPlaceholder(source.baseUrl) !== undefined) ||
    (source.type === "graphql" && oimOriginPlaceholder(source.url) !== undefined)
  ) {
    return true;
  }
  if (source.type !== "http") return false;
  if (
    (source.parameters ?? []).some((parameter) => {
      const field = (parameter as typeof parameter & { readonly configurationField?: unknown })
        .configurationField;
      return typeof field === "string" && fields.has(field);
    })
  ) {
    return true;
  }
  const argumentNames = new Set(
    (source.parameters ?? [])
      .filter((parameter) => parameter.value === undefined)
      .map((parameter) => parameter.name)
  );
  return [...source.path.matchAll(/\{([^{}]+)\}/g)].some((match) => {
    const name = match[1];
    return (
      name !== undefined &&
      name !== PATH_CREDENTIAL_PLACEHOLDER &&
      !argumentNames.has(name) &&
      fields.has(name)
    );
  });
}

/**
 * Resolves the live Connection and returns only the authority needed to build a Tool intent.
 * Plaintext remains behind the Secret Broker.
 */
export class OimOperationConnectionResolver {
  constructor(
    private readonly connections: ConnectionResolver,
    private readonly now: () => Date = () => new Date()
  ) {}

  async resolve(request: OimOperationConnectionRequest): Promise<OimOperationConnection> {
    const slot = request.operation.credentialSlot;
    if (slot === undefined && !requiresConfiguration(request.manifest, request.operation)) {
      return { kind: "public" };
    }

    const majorVersion = Number(request.manifest.metadata.version.split(".", 1)[0]);
    const resolutionRequest: ConnectionResolutionRequest = {
      businessId: request.businessId,
      integration: { id: request.manifest.metadata.id, majorVersion },
      identityMode: request.operation.identityMode,
      principal: request.principal,
      ...(request.personalOwnerId === undefined
        ? {}
        : { personalOwnerId: request.personalOwnerId }),
      ...(request.connectionId === undefined ? {} : { connectionId: request.connectionId }),
      ...(request.requireExplicitConnection === undefined
        ? {}
        : { requireExplicitConnection: request.requireExplicitConnection }),
    };
    const resolution = await this.connections.resolve(resolutionRequest);
    if (resolution.kind === "selection_required") {
      return {
        kind: resolution.reason === "ambiguous" ? "connection_ambiguous" : "connection_required",
        candidates: resolution.candidates,
      };
    }
    if (resolution.kind === "denied") {
      return { kind: "connection_denied", reason: resolution.reason };
    }

    const { connection } = resolution;
    if (connection.expiresAt !== null && new Date(connection.expiresAt) <= this.now()) {
      return { kind: "connection_unhealthy", connectionId: connection.id, status: "expired" };
    }
    if (connection.health.status === "action_required") {
      return {
        kind: "connection_unhealthy",
        connectionId: connection.id,
        status: connection.health.status,
      };
    }
    if (slot === undefined) return { kind: "configured", connection };
    const credentialRef = connection.secretBindings[slot];
    if (!secretReference(credentialRef)) {
      return { kind: "credential_required", connectionId: connection.id, credentialSlot: slot };
    }
    const secondarySlot = request.operation.secondaryCredential?.slot;
    const binding = {
      connectionId: connection.id,
      integrationId: request.manifest.metadata.id,
      credentialSlot: slot,
      principalKind: request.principal.kind,
      principalId: request.principal.id,
    };
    if (secondarySlot === undefined) {
      return { kind: "ready", connection, credentialRef, binding };
    }
    const secondaryCredentialRef = connection.secretBindings[secondarySlot];
    if (!secretReference(secondaryCredentialRef)) {
      return {
        kind: "credential_required",
        connectionId: connection.id,
        credentialSlot: secondarySlot,
      };
    }
    return {
      kind: "ready",
      connection,
      credentialRef,
      binding,
      secondaryCredentialRef,
      secondaryBinding: { ...binding, credentialSlot: secondarySlot },
    };
  }

  /** Rechecks a recorded binding before each lease and provider dispatch attempt. */
  async reauthorize(
    businessId: string,
    manifest: OimManifest,
    binding: ToolConnectionBinding,
    credentialRef: `secret://${string}`
  ): Promise<boolean> {
    if (
      binding.integrationId !== manifest.metadata.id ||
      binding.principalKind === undefined ||
      binding.principalId === undefined
    ) {
      return false;
    }
    return this.connections.reauthorizeBinding({
      businessId,
      integration: {
        id: manifest.metadata.id,
        majorVersion: Number(manifest.metadata.version.split(".", 1)[0]),
      },
      connectionId: binding.connectionId,
      credentialSlot: binding.credentialSlot,
      credentialRef,
      principal: { kind: binding.principalKind, id: binding.principalId },
    });
  }

  /**
   * Re-resolves the exact bound Connection so dispatch can also re-check its current configuration.
   */
  async reauthorizeConnection(
    businessId: string,
    manifest: OimManifest,
    operation: OimOperation,
    binding: ToolConnectionBinding,
    credentialRef: `secret://${string}`
  ): Promise<PersistedConnection | null> {
    if (
      binding.integrationId !== manifest.metadata.id ||
      binding.principalKind === undefined ||
      binding.principalId === undefined
    ) {
      return null;
    }
    const resolved = await this.resolve({
      businessId,
      manifest,
      operation,
      principal: { kind: binding.principalKind, id: binding.principalId },
      ...(binding.principalKind === "user" ? { personalOwnerId: binding.principalId } : {}),
      connectionId: binding.connectionId,
    });
    return resolved.kind === "ready" && resolved.credentialRef === credentialRef
      ? resolved.connection
      : null;
  }
}
