import { assertPublicEgressUrl, EgressDestinationError } from "@tulipfarm/integrations";
import {
  canonicalHash,
  type OimConnection,
  type OimManifest,
  type OimOperation,
  oimOriginPlaceholder,
} from "@tulipfarm/schema";
import type { PersistedConnection } from "@tulipfarm/storage";

const POLICY_EXTENSION = "x-tulipfarm-origin-policy";
const POLICY_MODE = "approved_public_exact";

export interface ConnectionOriginApproval {
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly configurationField: string;
  readonly origin: string;
  readonly bindingDigest: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface ConnectionOriginApprovalRepository {
  get(
    businessId: string,
    connectionId: string,
    configurationField: string
  ): Promise<ConnectionOriginApproval | null>;
  put(businessId: string, approval: ConnectionOriginApproval): Promise<void>;
  delete(businessId: string, connectionId: string, configurationField: string): Promise<void>;
}

export interface OimApprovedOriginResolver {
  manifestForOperation(input: {
    readonly businessId: string;
    readonly manifest: OimManifest;
    readonly operation: OimOperation;
    readonly connection: PersistedConnection;
  }): Promise<OimManifest>;
}

export type ConnectionOriginPolicyErrorCode =
  | "policy_not_declared"
  | "connection_inactive"
  | "connection_mismatch"
  | "origin_unconfigured"
  | "origin_invalid"
  | "approval_missing"
  | "approval_mismatch";

export class ConnectionOriginPolicyError extends Error {
  readonly name = "ConnectionOriginPolicyError";

  constructor(readonly code: ConnectionOriginPolicyErrorCode) {
    super(`connection_origin_policy:${code}`);
  }
}

interface ApprovedOriginPolicy {
  readonly mode: typeof POLICY_MODE;
  readonly fields: readonly string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function approvedOriginPolicy(manifest: OimManifest): ApprovedOriginPolicy | undefined {
  const extension = record(manifest.extensions?.[POLICY_EXTENSION]);
  if (extension?.mode !== POLICY_MODE || !Array.isArray(extension.fields)) return undefined;
  const fields = extension.fields.filter((field): field is string => typeof field === "string");
  if (fields.length !== extension.fields.length || fields.length === 0) return undefined;
  return { mode: POLICY_MODE, fields };
}

function publicHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized === "home.arpa" ||
    normalized.endsWith(".home.arpa")
  ) {
    return false;
  }
  return normalized.includes(".") || normalized.includes(":");
}

export function canonicalApprovedPublicOrigin(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    assertPublicEgressUrl(url, trimmed);
  } catch (error) {
    if (error instanceof TypeError || error instanceof EgressDestinationError) {
      throw new ConnectionOriginPolicyError("origin_invalid");
    }
    throw error;
  }
  if (
    !publicHostname(url.hostname) ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ConnectionOriginPolicyError("origin_invalid");
  }
  return url.origin;
}

export function connectionOriginBindingDigest(input: {
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly configurationField: string;
  readonly origin: string;
}): string {
  return canonicalHash({
    connectionId: input.connectionId,
    integrationId: input.integrationId,
    integrationMajorVersion: input.integrationMajorVersion,
    configurationField: input.configurationField,
    origin: canonicalApprovedPublicOrigin(input.origin),
  });
}

function manifestUsesOriginField(manifest: OimManifest, field: string): boolean {
  return manifest.operations.some((operation) => {
    if (operation.source.type !== "http" && operation.source.type !== "openapi") return false;
    return (
      operation.source.baseUrl !== undefined &&
      oimOriginPlaceholder(operation.source.baseUrl) === field
    );
  });
}

function operationOriginField(operation: OimOperation): string | undefined {
  if (
    (operation.source.type !== "http" && operation.source.type !== "openapi") ||
    operation.source.baseUrl === undefined
  ) {
    return undefined;
  }
  return oimOriginPlaceholder(operation.source.baseUrl);
}

/**
 * Whether one declared Connection configuration field may bypass the manifest's static host list
 * while it waits for trusted exact-origin approval.
 */
export function oimConnectionOriginRequiresApproval(
  manifest: OimManifest,
  configurationField: string
): boolean {
  const policy = approvedOriginPolicy(manifest);
  const declaredField = manifest.auth?.configurationFields?.find(
    (field) => field.id === configurationField
  );
  return (
    policy?.fields.includes(configurationField) === true &&
    (declaredField?.type === "string" || declaredField?.type === "url") &&
    manifestUsesOriginField(manifest, configurationField)
  );
}

function assertConnectionPolicyTarget(
  manifest: OimManifest,
  connection: OimConnection,
  configurationField: string
): void {
  if (!oimConnectionOriginRequiresApproval(manifest, configurationField)) {
    throw new ConnectionOriginPolicyError("policy_not_declared");
  }
  if (connection.status !== "active") {
    throw new ConnectionOriginPolicyError("connection_inactive");
  }
  const majorVersion = Number(manifest.metadata.version.split(".", 1)[0]);
  if (
    connection.integration.id !== manifest.metadata.id ||
    connection.integration.majorVersion !== majorVersion
  ) {
    throw new ConnectionOriginPolicyError("connection_mismatch");
  }
}

/**
 * Builds the record a trusted confirmation handler persists.
 *
 * The handler supplies only the authenticated operator identity. The origin always comes from the
 * live Connection, so a request cannot approve benign bytes and substitute another destination.
 */
export function connectionOriginApprovalForTrustedConfirmation(input: {
  readonly manifest: OimManifest;
  readonly connection: OimConnection;
  readonly configurationField: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}): ConnectionOriginApproval {
  const { manifest, connection, configurationField } = input;
  assertConnectionPolicyTarget(manifest, connection, configurationField);
  const configured = connection.configuration[configurationField];
  if (typeof configured !== "string") {
    throw new ConnectionOriginPolicyError("origin_unconfigured");
  }
  const origin = canonicalApprovedPublicOrigin(configured);
  return {
    connectionId: connection.id,
    integrationId: connection.integration.id,
    integrationMajorVersion: connection.integration.majorVersion,
    configurationField,
    origin,
    bindingDigest: connectionOriginBindingDigest({
      connectionId: connection.id,
      integrationId: connection.integration.id,
      integrationMajorVersion: connection.integration.majorVersion,
      configurationField,
      origin,
    }),
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
  };
}

/**
 * Adds one exact, operator-confirmed Connection origin to a cloned manifest.
 *
 * The approval must come from trusted persistence after the runtime's explicit confirmation
 * action. This helper intentionally accepts no caller-supplied `granted` flag.
 */
export function manifestForApprovedConnectionOrigin(input: {
  readonly manifest: OimManifest;
  readonly connection: OimConnection;
  readonly approval: ConnectionOriginApproval;
}): OimManifest {
  const { manifest, connection, approval } = input;
  assertConnectionPolicyTarget(manifest, connection, approval.configurationField);
  if (
    connection.id !== approval.connectionId ||
    connection.integration.id !== approval.integrationId ||
    connection.integration.majorVersion !== approval.integrationMajorVersion
  ) {
    throw new ConnectionOriginPolicyError("connection_mismatch");
  }
  const configured = connection.configuration[approval.configurationField];
  if (typeof configured !== "string") {
    throw new ConnectionOriginPolicyError("origin_unconfigured");
  }
  const origin = canonicalApprovedPublicOrigin(configured);
  if (
    canonicalApprovedPublicOrigin(approval.origin) !== origin ||
    approval.bindingDigest !==
      connectionOriginBindingDigest({
        connectionId: connection.id,
        integrationId: connection.integration.id,
        integrationMajorVersion: connection.integration.majorVersion,
        configurationField: approval.configurationField,
        origin,
      })
  ) {
    throw new ConnectionOriginPolicyError("approval_mismatch");
  }
  if (manifest.auth === undefined) {
    throw new ConnectionOriginPolicyError("policy_not_declared");
  }
  const host = new URL(origin).host;
  return {
    ...manifest,
    auth: {
      ...manifest.auth,
      allowedOriginHosts: [...new Set([...(manifest.auth.allowedOriginHosts ?? []), host])],
    },
  };
}

/**
 * Resolves an operation's manifest from trusted approval persistence.
 *
 * Operations without an approved-exact policy retain the manifest's static allowlist. A
 * policy-bound operation fails closed until its exact live Connection binding is approved.
 */
export function createOimApprovedOriginResolver(
  approvals: Pick<ConnectionOriginApprovalRepository, "get">
): OimApprovedOriginResolver {
  return {
    async manifestForOperation(input): Promise<OimManifest> {
      const operation = input.manifest.operations.find(
        (candidate) => candidate.id === input.operation.id
      );
      if (operation === undefined) {
        throw new ConnectionOriginPolicyError("connection_mismatch");
      }
      const configurationField = operationOriginField(operation);
      if (
        configurationField === undefined ||
        !oimConnectionOriginRequiresApproval(input.manifest, configurationField)
      ) {
        return input.manifest;
      }
      const approval = await approvals.get(
        input.businessId,
        input.connection.id,
        configurationField
      );
      if (approval === null) {
        throw new ConnectionOriginPolicyError("approval_missing");
      }
      return manifestForApprovedConnectionOrigin({
        manifest: input.manifest,
        connection: input.connection,
        approval,
      });
    },
  };
}
