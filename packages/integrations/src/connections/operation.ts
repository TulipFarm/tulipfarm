import {
  type OimManifest,
  type OimOperation,
  oimOriginPlaceholder,
  PATH_CREDENTIAL_PLACEHOLDER,
} from "@tulipfarm/schema";
import type { ConnectionAuthStep, PersistedConnection } from "@tulipfarm/storage";
import { oimManifestMajor } from "./catalog";
import type {
  ConnectionPrincipal,
  ConnectionResolutionRequest,
  ConnectionResolver,
  ConnectionSummary,
} from "./resolver";

export interface ToolConnectionBinding {
  readonly connectionId: string;
  readonly integrationId: string;
  readonly credentialSlot: string;
  readonly identityMode: OimOperation["identityMode"];
  readonly principalKind?: string;
  readonly principalId?: string;
}

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
  | {
      readonly kind: "configured";
      readonly connection: PersistedConnection;
      readonly availableCredentialSlots: readonly string[];
    }
  | {
      readonly kind: "ready";
      readonly connection: PersistedConnection;
      readonly availableCredentialSlots: readonly string[];
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
      readonly stepId?: string;
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

export interface ConnectionAuthStepReader {
  list(businessId: string, connectionId: string): Promise<readonly ConnectionAuthStep[]>;
}

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
  const argumentsFromCaller = new Set(
    (source.parameters ?? [])
      .filter((parameter) => parameter.value === undefined)
      .map((parameter) => parameter.name)
  );
  return [...source.path.matchAll(/\{([^{}]+)\}/g)].some((match) => {
    const name = match[1];
    return (
      name !== undefined &&
      name !== PATH_CREDENTIAL_PLACEHOLDER &&
      !argumentsFromCaller.has(name) &&
      fields.has(name)
    );
  });
}

function browserStepForSlot(manifest: OimManifest, slot: string): string | undefined {
  return (manifest.auth?.steps ?? []).find(
    (step) =>
      (step.type === "oauth2" || step.type === "app_manifest" || step.type === "install") &&
      step.bindings.some(
        (binding) => binding.target.type === "credential" && binding.target.slot === slot
      )
  )?.id;
}

function availableSlots(
  manifest: OimManifest,
  connection: PersistedConnection,
  authSteps: readonly ConnectionAuthStep[],
  now: Date
): readonly string[] {
  const steps = new Map(authSteps.map((step) => [step.stepId, step]));
  return Object.entries(connection.secretBindings)
    .filter(([slot, reference]) => {
      if (!secretReference(reference)) return false;
      const stepId = browserStepForSlot(manifest, slot);
      if (stepId === undefined) return true;
      const step = steps.get(stepId);
      return (
        step?.status === "active" &&
        (step.expiresAt === null || new Date(step.expiresAt) > now) &&
        (step.accessSlot !== slot || step.accessSecretRef === reference) &&
        (step.refreshSlot !== slot || step.refreshSecretRef === reference)
      );
    })
    .map(([slot]) => slot)
    .sort();
}

export class OimOperationConnectionResolver {
  constructor(
    private readonly connections: ConnectionResolver,
    private readonly authSteps: ConnectionAuthStepReader,
    private readonly now: () => Date = () => new Date()
  ) {}

  async resolve(request: OimOperationConnectionRequest): Promise<OimOperationConnection> {
    const slot = request.operation.credentialSlot;
    if (slot === undefined && !requiresConfiguration(request.manifest, request.operation)) {
      return { kind: "public" };
    }

    const resolutionRequest: ConnectionResolutionRequest = {
      businessId: request.businessId,
      integration: {
        id: request.manifest.metadata.id,
        majorVersion: oimManifestMajor(request.manifest),
      },
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
    const now = this.now();
    if (connection.expiresAt !== null && new Date(connection.expiresAt) <= now) {
      return { kind: "connection_unhealthy", connectionId: connection.id, status: "expired" };
    }
    if (connection.health.status !== "healthy" && connection.health.status !== "expiring") {
      return {
        kind: "connection_unhealthy",
        connectionId: connection.id,
        status: connection.health.status,
      };
    }

    const stepRows = await this.authSteps.list(connection.businessId, connection.id);
    const slots = availableSlots(request.manifest, connection, stepRows, now);
    if (slot === undefined) {
      return { kind: "configured", connection, availableCredentialSlots: slots };
    }
    const stepId = browserStepForSlot(request.manifest, slot);
    if (stepId !== undefined) {
      const step = stepRows.find((candidate) => candidate.stepId === stepId);
      const stepExpired = step?.expiresAt != null && new Date(step.expiresAt) <= now;
      if (step?.status !== "active" || stepExpired) {
        return {
          kind: "connection_unhealthy",
          connectionId: connection.id,
          status: step?.status === "expired" || stepExpired ? "expired" : "action_required",
          stepId,
        };
      }
    }

    const credentialRef = connection.secretBindings[slot];
    if (!secretReference(credentialRef) || !slots.includes(slot)) {
      return { kind: "credential_required", connectionId: connection.id, credentialSlot: slot };
    }
    const secondarySlot = request.operation.secondaryCredential?.slot;
    const binding = {
      connectionId: connection.id,
      integrationId: request.manifest.metadata.id,
      credentialSlot: slot,
      identityMode: request.operation.identityMode,
      principalKind: request.principal.kind,
      principalId: request.principal.id,
    };
    if (secondarySlot === undefined) {
      return {
        kind: "ready",
        connection,
        availableCredentialSlots: slots,
        credentialRef,
        binding,
      };
    }
    const secondaryCredentialRef = connection.secretBindings[secondarySlot];
    if (!secretReference(secondaryCredentialRef) || !slots.includes(secondarySlot)) {
      return {
        kind: "credential_required",
        connectionId: connection.id,
        credentialSlot: secondarySlot,
      };
    }
    return {
      kind: "ready",
      connection,
      availableCredentialSlots: slots,
      credentialRef,
      binding,
      secondaryCredentialRef,
      secondaryBinding: { ...binding, credentialSlot: secondarySlot },
    };
  }

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
    const principal = { kind: binding.principalKind, id: binding.principalId };
    const resolution = await this.connections.resolve({
      businessId,
      integration: {
        id: manifest.metadata.id,
        majorVersion: oimManifestMajor(manifest),
      },
      identityMode: binding.identityMode,
      principal,
      ...(principal.kind === "user" ? { personalOwnerId: principal.id } : {}),
      connectionId: binding.connectionId,
    });
    if (resolution.kind !== "selected") return false;
    const connection = resolution.connection;
    const now = this.now();
    if (
      (connection.expiresAt !== null && new Date(connection.expiresAt) <= now) ||
      (connection.health.status !== "healthy" && connection.health.status !== "expiring") ||
      connection.secretBindings[binding.credentialSlot] !== credentialRef
    ) {
      return false;
    }
    const rows = await this.authSteps.list(connection.businessId, connection.id);
    return availableSlots(manifest, connection, rows, now).includes(binding.credentialSlot);
  }
}
