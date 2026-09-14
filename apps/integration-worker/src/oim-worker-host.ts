import type {
  OimKnowledgeSyncOptions,
  ProviderAclEntry,
  VerifiedProviderIdentity,
  WebhookRegistrationCredentialPort,
  WebhookRegistrationProvider,
} from "@tulipfarm/integrations";
import { canonicalHash, type OimManifest, validateOimManifest } from "@tulipfarm/schema";
import type { InternalApiClient } from "./internal/client";

const OIM_WORKER_CONTRACT_VERSION = 1;
const REQUIRED_CAPABILITIES = [
  "connection-bound-operations",
  "exact-manifest-resolution",
  "hooks",
  "knowledge-registrations",
  "payload-crypto",
  "verified-provider-identity",
  "webhook-registration",
] as const;

export interface OimPollingRegistration {
  readonly businessId: string;
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
}

export interface OimKnowledgeRegistration {
  readonly id: string;
  readonly manifest: OimManifest;
  readonly manifestDigest: string;
  readonly options: OimKnowledgeSyncOptions;
  readonly verifiedIdentity: VerifiedProviderIdentity;
}

export interface OimPollingExecution {
  readonly response: unknown;
  readonly authenticatedEvidenceDigest: string;
  readonly verifiedIdentity: VerifiedProviderIdentity;
}

export interface OimWorkerHost {
  assertReady(): Promise<void>;
  listPollingRegistrations(): Promise<readonly OimPollingRegistration[]>;
  resolveConnectionManifest(input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly integrationId: string;
    readonly integrationMajorVersion: number;
  }): Promise<OimManifest | null>;
  resolveIntegrationManifest(input: {
    readonly businessId: string;
    readonly integrationId: string;
    readonly integrationMajorVersion: number;
  }): Promise<OimManifest | null>;
  /**
   * The host must verify the canonical package and expected manifest digest, then perform the
   * final current Connection and credential admission immediately before the provider request.
   */
  executePollingOperation(input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly integrationId: string;
    readonly integrationMajorVersion: number;
    readonly operationId: string;
    readonly expectedManifestDigest: string;
    readonly cursor: string | number | null;
    readonly leaseToken: string;
    readonly purpose: "ingress_poll";
  }): Promise<OimPollingExecution>;
  resolveRegistrationManifest(integrationKey: string): Promise<OimManifest | null>;
  stageWebhookCredential: WebhookRegistrationCredentialPort["stage"];
  revokeWebhookCredential: WebhookRegistrationCredentialPort["revoke"];
  revokeWebhookCredentialAttempt: WebhookRegistrationCredentialPort["revokeAttempt"];
  registerWebhook: WebhookRegistrationProvider["register"];
  reconcileWebhook: WebhookRegistrationProvider["reconcile"];
  renewWebhook: WebhookRegistrationProvider["renew"];
  unregisterWebhook: WebhookRegistrationProvider["unregister"];
  encryptPayload(payload: Buffer): Promise<string>;
  decryptPayload(encryptedPayload: string): Promise<Buffer>;
  runHook(input: {
    readonly businessId: string;
    readonly integrationId: string;
    readonly integrationMajorVersion: number;
    readonly hook: unknown;
    readonly phaseInput: unknown;
  }): Promise<unknown>;
  listKnowledgeRegistrations(): Promise<readonly OimKnowledgeRegistration[]>;
  /**
   * The host must verify the canonical package and expected manifest digest, then perform the
   * final current Connection and credential admission immediately before the provider request.
   */
  executeKnowledgeOperation(input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly integrationId: string;
    readonly integrationMajorVersion: number;
    readonly operationId: string;
    readonly expectedManifestDigest: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly pageToken?: string;
    readonly purpose: "knowledge_sync";
  }): Promise<{ readonly body: unknown; readonly nextPageToken?: string }>;
  resolveKnowledgeIdentities(
    input: {
      readonly businessId: string;
      readonly integrationId: string;
      readonly integrationMajorVersion: number;
      readonly connectionId: string;
      readonly externalTenantId: string;
      readonly externalAccountId: string;
    },
    entries: readonly ProviderAclEntry[]
  ): Promise<{
    readonly principals: readonly Readonly<{ kind: string; id: string }>[];
    readonly incomplete: boolean;
  }>;
}

interface ManifestResponse {
  readonly manifest: unknown;
  readonly manifestDigest: string;
}

interface StagedCredentialResponse {
  readonly stagedCredentialRef: string;
  readonly useToken: string;
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value: unknown, context: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${context} must be a non-negative integer`);
  }
  return value as number;
}

function parseManifest(response: ManifestResponse, expectedDigest?: string): OimManifest {
  const manifest = validateOimManifest(response.manifest);
  const actualDigest = canonicalHash(manifest);
  if (
    actualDigest !== response.manifestDigest ||
    (expectedDigest && actualDigest !== expectedDigest)
  ) {
    throw new Error("Internal OIM manifest response failed digest verification");
  }
  return manifest;
}

function parseVerifiedIdentity(value: unknown): VerifiedProviderIdentity {
  const identity = requireRecord(value, "verifiedIdentity");
  return {
    externalTenantId: requireString(identity.externalTenantId, "verifiedIdentity.externalTenantId"),
    externalAccountId: requireString(
      identity.externalAccountId,
      "verifiedIdentity.externalAccountId"
    ),
  };
}

export class InternalOimWorkerHost implements OimWorkerHost {
  constructor(private readonly client: InternalApiClient) {}

  async assertReady(): Promise<void> {
    const response = requireRecord(
      await this.client.require<unknown>("GET", "/api/v1/internal/oim/worker-contract"),
      "OIM worker contract"
    );
    if (response.version !== OIM_WORKER_CONTRACT_VERSION) {
      throw new Error(
        `OIM worker contract version ${String(response.version)} is not supported; expected ${OIM_WORKER_CONTRACT_VERSION}`
      );
    }
    if (!Array.isArray(response.capabilities)) {
      throw new Error("OIM worker contract capabilities must be an array");
    }
    const capabilities = new Set(response.capabilities);
    const missing = REQUIRED_CAPABILITIES.filter((capability) => !capabilities.has(capability));
    if (missing.length > 0) {
      throw new Error(`OIM worker contract is missing capabilities: ${missing.join(", ")}`);
    }
  }

  async listPollingRegistrations(): Promise<readonly OimPollingRegistration[]> {
    const response = await this.client.require<unknown>(
      "GET",
      "/api/v1/internal/oim/polling-registrations"
    );
    if (!Array.isArray(response)) {
      throw new Error("OIM polling registrations response must be an array");
    }
    return response.map((value, index) => {
      const registration = requireRecord(value, `polling registration ${index}`);
      return {
        businessId: requireString(registration.businessId, "polling registration businessId"),
        connectionId: requireString(registration.connectionId, "polling registration connectionId"),
        integrationId: requireString(
          registration.integrationId,
          "polling registration integrationId"
        ),
        integrationMajorVersion: requireInteger(
          registration.integrationMajorVersion,
          "polling registration integrationMajorVersion"
        ),
      };
    });
  }

  async resolveConnectionManifest(
    input: Parameters<OimWorkerHost["resolveConnectionManifest"]>[0]
  ): Promise<OimManifest | null> {
    const response = await this.findManifest("/api/v1/internal/oim/manifests/connection", input);
    if (!response) {
      return null;
    }
    const manifest = parseManifest(response);
    const major = Number.parseInt(manifest.metadata.version.split(".")[0] ?? "", 10);
    if (manifest.metadata.id !== input.integrationId || major !== input.integrationMajorVersion) {
      throw new Error("Internal OIM manifest response crossed the requested Integration identity");
    }
    return manifest;
  }

  async resolveIntegrationManifest(
    input: Parameters<OimWorkerHost["resolveIntegrationManifest"]>[0]
  ): Promise<OimManifest | null> {
    const response = await this.findManifest("/api/v1/internal/oim/manifests/integration", input);
    if (!response) {
      return null;
    }
    const manifest = parseManifest(response);
    const major = Number.parseInt(manifest.metadata.version.split(".")[0] ?? "", 10);
    if (manifest.metadata.id !== input.integrationId || major !== input.integrationMajorVersion) {
      throw new Error("Internal OIM manifest response crossed the requested Integration identity");
    }
    return manifest;
  }

  async executePollingOperation(
    input: Parameters<OimWorkerHost["executePollingOperation"]>[0]
  ): Promise<OimPollingExecution> {
    const response = requireRecord(
      await this.client.require<unknown>("POST", "/api/v1/internal/oim/operations/poll", input),
      "OIM polling operation response"
    );
    return {
      response: response.response,
      authenticatedEvidenceDigest: requireString(
        response.authenticatedEvidenceDigest,
        "polling authenticatedEvidenceDigest"
      ),
      verifiedIdentity: parseVerifiedIdentity(response.verifiedIdentity),
    };
  }

  async resolveRegistrationManifest(integrationKey: string): Promise<OimManifest | null> {
    const response = await this.findManifest("/api/v1/internal/oim/manifests/registration", {
      integrationKey,
    });
    return response ? parseManifest(response) : null;
  }

  async stageWebhookCredential(
    ...parameters: Parameters<WebhookRegistrationCredentialPort["stage"]>
  ): ReturnType<WebhookRegistrationCredentialPort["stage"]> {
    const response = requireRecord(
      await this.client.require<unknown>(
        "POST",
        "/api/v1/internal/oim/webhook-credentials/stage",
        parameters[0]
      ),
      "staged webhook credential"
    );
    const staged = response as unknown as StagedCredentialResponse;
    const stagedCredentialRef = requireString(staged.stagedCredentialRef, "stagedCredentialRef");
    const useToken = requireString(staged.useToken, "useToken");
    let consumed = false;
    return {
      ref: stagedCredentialRef as `secret://${string}`,
      use: async (operation) => {
        if (consumed) {
          throw new Error("Staged webhook credential use token was already consumed");
        }
        consumed = true;
        return operation(useToken);
      },
    };
  }

  async revokeWebhookCredential(
    ...parameters: Parameters<WebhookRegistrationCredentialPort["revoke"]>
  ): ReturnType<WebhookRegistrationCredentialPort["revoke"]> {
    await this.client.require("POST", "/api/v1/internal/oim/webhook-credentials/revoke", {
      reference: parameters[0],
    });
  }

  async revokeWebhookCredentialAttempt(
    ...parameters: Parameters<WebhookRegistrationCredentialPort["revokeAttempt"]>
  ): ReturnType<WebhookRegistrationCredentialPort["revokeAttempt"]> {
    await this.client.require("POST", "/api/v1/internal/oim/webhook-credentials/revoke-attempt", {
      attemptId: parameters[0],
    });
  }

  async registerWebhook(
    ...parameters: Parameters<WebhookRegistrationProvider["register"]>
  ): ReturnType<WebhookRegistrationProvider["register"]> {
    return this.client.require("POST", "/api/v1/internal/oim/webhooks/register", parameters[0]);
  }

  async reconcileWebhook(
    ...parameters: Parameters<WebhookRegistrationProvider["reconcile"]>
  ): ReturnType<WebhookRegistrationProvider["reconcile"]> {
    return this.client.require("POST", "/api/v1/internal/oim/webhooks/reconcile", parameters[0]);
  }

  async renewWebhook(
    ...parameters: Parameters<WebhookRegistrationProvider["renew"]>
  ): ReturnType<WebhookRegistrationProvider["renew"]> {
    return this.client.require("POST", "/api/v1/internal/oim/webhooks/renew", parameters[0]);
  }

  async unregisterWebhook(
    ...parameters: Parameters<WebhookRegistrationProvider["unregister"]>
  ): ReturnType<WebhookRegistrationProvider["unregister"]> {
    return this.client.require("POST", "/api/v1/internal/oim/webhooks/unregister", parameters[0]);
  }

  async encryptPayload(payload: Buffer): Promise<string> {
    const response = requireRecord(
      await this.client.require<unknown>("POST", "/api/v1/internal/oim/payloads/encrypt", {
        plaintextBase64: payload.toString("base64"),
      }),
      "encrypted OIM payload"
    );
    return requireString(response.encryptedPayload, "encryptedPayload");
  }

  async decryptPayload(encryptedPayload: string): Promise<Buffer> {
    const response = requireRecord(
      await this.client.require<unknown>("POST", "/api/v1/internal/oim/payloads/decrypt", {
        encryptedPayload,
      }),
      "decrypted OIM payload"
    );
    return Buffer.from(requireString(response.plaintextBase64, "plaintextBase64"), "base64");
  }

  async runHook(input: Parameters<OimWorkerHost["runHook"]>[0]): Promise<unknown> {
    return this.client.require("POST", "/api/v1/internal/oim/hooks/run", input);
  }

  async listKnowledgeRegistrations(): Promise<readonly OimKnowledgeRegistration[]> {
    const response = await this.client.require<unknown>(
      "GET",
      "/api/v1/internal/oim/knowledge-registrations"
    );
    if (!Array.isArray(response)) {
      throw new Error("OIM Knowledge registrations response must be an array");
    }
    return response.map((value, index) => {
      const registration = requireRecord(value, `Knowledge registration ${index}`);
      const manifestDigest = requireString(
        registration.manifestDigest,
        "Knowledge registration manifestDigest"
      );
      return {
        id: requireString(registration.id, "Knowledge registration id"),
        manifest: parseManifest(
          {
            manifest: registration.manifest,
            manifestDigest,
          },
          manifestDigest
        ),
        manifestDigest,
        options: requireRecord(
          registration.options,
          "Knowledge registration options"
        ) as unknown as OimKnowledgeSyncOptions,
        verifiedIdentity: parseVerifiedIdentity(registration.verifiedIdentity),
      };
    });
  }

  async executeKnowledgeOperation(
    input: Parameters<OimWorkerHost["executeKnowledgeOperation"]>[0]
  ): Promise<{ readonly body: unknown; readonly nextPageToken?: string }> {
    return this.client.require("POST", "/api/v1/internal/oim/operations/execute", input);
  }

  async resolveKnowledgeIdentities(
    input: Parameters<OimWorkerHost["resolveKnowledgeIdentities"]>[0],
    entries: readonly ProviderAclEntry[]
  ): Promise<{
    readonly principals: readonly Readonly<{ kind: string; id: string }>[];
    readonly incomplete: boolean;
  }> {
    const response = requireRecord(
      await this.client.require<unknown>(
        "POST",
        "/api/v1/internal/oim/knowledge-identities/resolve",
        {
          ...input,
          entries,
        }
      ),
      "resolved OIM Knowledge identities"
    );
    if (!Array.isArray(response.principals) || typeof response.incomplete !== "boolean") {
      throw new Error("Resolved OIM Knowledge identities are invalid");
    }
    return {
      principals: response.principals.map((value, index) => {
        const principal = requireRecord(value, `resolved principal ${index}`);
        return {
          kind: requireString(principal.kind, `resolved principal ${index} kind`),
          id: requireString(principal.id, `resolved principal ${index} id`),
        };
      }),
      incomplete: response.incomplete,
    };
  }

  private async findManifest(path: string, body: unknown): Promise<ManifestResponse | null> {
    const found = await this.client.find<unknown>("POST", path, [404], body);
    if (found === undefined) {
      return null;
    }
    const response = requireRecord(found, "OIM manifest response");
    return {
      manifest: response.manifest,
      manifestDigest: requireString(response.manifestDigest, "manifestDigest"),
    };
  }
}
