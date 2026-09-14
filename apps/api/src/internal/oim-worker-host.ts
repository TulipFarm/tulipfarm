import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  type CompiledOimCompositeTool,
  type CompiledOimGraphqlTool,
  type CompiledOimHttpTool,
  type CompiledOimOpenApiTool,
  type ConnectionReader,
  compileOimCompositeOperations,
  compileOimGraphqlOperations,
  compileOimHttpOperations,
  compileOimOpenApiOperations,
  NEXT_PAGE_TOKEN_PROPERTY,
  OimCompositeToolAdapter,
  OimGraphqlToolAdapter,
  type OimHookPhaseRunner,
  OimHttpToolAdapter,
  type OimKnowledgeSyncOptions,
  type OimOperationConnectionResolver,
  type OimPaginationRuntime,
  PAGE_TOKEN_ARGUMENT,
  type ProviderAclEntry,
  projectVerifiedConnectionIdentity,
  readPointer,
  type WebhookRegistrationProvider,
} from "@tulipfarm/integrations";
import { BLANKET_READ_PRINCIPAL } from "@tulipfarm/knowledge";
import type { HookExecutor } from "@tulipfarm/sandbox";
import { canonicalHash, type OimManifest, oimPackageDigest } from "@tulipfarm/schema";
import {
  decryptSecret,
  encryptSecret,
  SecretBroker,
  type SecretEnvelope,
  type SecretsService,
  secretStorageKey,
  secretsServiceProvider,
} from "@tulipfarm/secrets";
import type { SoulIntegration } from "@tulipfarm/soul";
import type {
  ActiveWebhookRegistration,
  ConnectionVerificationEvidenceStore,
  PersistedConnection,
  Queryable,
  WebhookRegistrationKey,
  WebhookRegistrationTarget,
} from "@tulipfarm/storage";
import {
  AdapterDispatchError,
  CredentialDispatcher,
  type EffectRecord,
  type ToolAdapter,
} from "@tulipfarm/tool-broker";
import { type ExternalIdentityRepo, isProvenLink } from "../identity/external-links";
import { signToken, verifyToken } from "../identity/signed-token";
import type {
  OimDispatchSettlement,
  OimReleaseDispatchPort,
} from "../integrations/releases/dispatch-host";
import { loadOimWebhookCleanupPackage } from "./oim-webhook-cleanup-package";
import { type InternalOimWorkerRouteDeps, InternalOimWorkerRouteError } from "./oim-worker-routes";

const WORKER_PRINCIPAL = { kind: "service", id: "integration-worker" } as const;
const WEBHOOK_TOKEN_DOMAIN = "tulipfarm-oim-webhook-use-token-v1";
const WEBHOOK_SECRET_REFERENCE =
  /^secret:\/\/[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ActiveOimPackage {
  readonly key: string;
  readonly manifest: OimManifest;
  readonly integration: SoulIntegration;
}

type UnregisterWebhookInput = Parameters<WebhookRegistrationProvider["unregister"]>[0];

export interface OimWebhookCleanupAuthorization {
  authorize(
    input: UnregisterWebhookInput,
    now: Date
  ): Promise<{ readonly generation: number } | null>;
}

export class PgOimWebhookCleanupAuthorization implements OimWebhookCleanupAuthorization {
  constructor(private readonly database: Queryable) {}

  async authorize(
    input: UnregisterWebhookInput,
    now: Date
  ): Promise<{ readonly generation: number } | null> {
    const parameters = [
      input.key.businessId,
      input.key.connectionId,
      input.key.integrationId,
      input.key.integrationMajorVersion,
      JSON.stringify(input.target),
      JSON.stringify(input.registration),
      input.idempotencyKey,
      now,
    ];
    const result = await this.database.query<{ generation: number | string }>(
      `WITH current_cleanup AS (
         SELECT registration.generation
           FROM oim_webhook_registrations registration
           JOIN oim_ingress_teardowns teardown
             ON teardown.business_id = registration.business_id
            AND teardown.connection_id = registration.connection_id
          WHERE registration.business_id = $1 AND registration.connection_id = $2
            AND registration.integration_id = $3
            AND registration.integration_major_version = $4
            AND registration.desired_state = 'removed'
            AND registration.state IN ('removing', 'cleanup_failed')
            AND registration.target = $5::jsonb
            AND registration.active_registration = $6::jsonb
            AND registration.lease_token IS NOT NULL
            AND registration.lease_expires_at > $8
            AND $7 = concat(
              registration.business_id, ':', registration.connection_id, ':remove:',
              registration.active_registration->>'subscriptionId'
            )
       ), attempt_cleanup AS (
         SELECT attempt.generation
           FROM oim_webhook_registration_attempts attempt
           JOIN oim_ingress_teardowns teardown
             ON teardown.business_id = attempt.business_id
            AND teardown.connection_id = attempt.connection_id
          WHERE attempt.business_id = $1 AND attempt.connection_id = $2
            AND attempt.integration_id = $3 AND attempt.integration_major_version = $4
            AND attempt.state IN ('cleanup_pending', 'cleanup_failed')
            AND attempt.target = $5::jsonb
            AND attempt.subscription_id = ($6::jsonb)->>'subscriptionId'
            AND attempt.secret_ref = ($6::jsonb)->>'secretRef'
            AND attempt.lease_token IS NOT NULL AND attempt.lease_expires_at > $8
            AND $7 = concat(attempt.idempotency_key, ':remove')
       )
       SELECT generation FROM current_cleanup
       UNION ALL
       SELECT generation FROM attempt_cleanup`,
      parameters
    );
    if (result.rows.length !== 1) return null;
    const generation = Number(result.rows[0]?.generation);
    return Number.isSafeInteger(generation) && generation > 0 ? { generation } : null;
  }
}

export interface PersistedOimKnowledgeRegistration {
  readonly businessId: string;
  readonly integrationSlug: string;
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly sourceKindId: string;
  readonly scopes: readonly string[];
  readonly classification?: readonly string[];
  readonly aclMaximumAgeSeconds?: number;
  readonly liveMaximumAgeSeconds?: number;
}

export interface InternalOimWorkerHostDeps {
  readonly integrations: () => Iterable<readonly [string, SoulIntegration]>;
  readonly releaseDispatch: OimReleaseDispatchPort;
  readonly connections: ConnectionReader & {
    listPollingFallbacks(): Promise<readonly PersistedConnection[]>;
  };
  readonly connectionOperations: OimOperationConnectionResolver;
  readonly cleanupConnectionOperations?: OimOperationConnectionResolver;
  readonly cleanupAuthorization?: OimWebhookCleanupAuthorization;
  readonly cleanupPackages?: {
    load(
      integrationKey: string,
      snapshot: WebhookRegistrationTarget["packageSnapshot"]
    ): { readonly key: string; readonly integration: SoulIntegration };
  };
  readonly verificationEvidence: Pick<
    ConnectionVerificationEvidenceStore,
    "findCurrentForConnection"
  >;
  readonly secrets: SecretsService;
  readonly http: ConstructorParameters<typeof OimHttpToolAdapter>[0]["http"];
  readonly paginationRuntime: OimPaginationRuntime;
  readonly payloadKey: Buffer;
  readonly hookExecutor?: Pick<HookExecutor, "runPureHook">;
  readonly knowledgeRegistrations: {
    list(): Promise<readonly PersistedOimKnowledgeRegistration[]>;
  };
  readonly externalIdentities: Pick<ExternalIdentityRepo, "findMapping">;
  readonly now?: () => Date;
}

function sameWebhookTarget(
  target: WebhookRegistrationTarget,
  registration: ActiveWebhookRegistration
): boolean {
  return (
    target.integrationKey === registration.integrationKey &&
    target.manifestDigest === registration.manifestDigest &&
    target.stepId === registration.stepId &&
    target.callbackUrl === registration.callbackUrl &&
    target.operationId === registration.operationId &&
    target.unregisterOperationId === registration.unregisterOperationId &&
    target.secretSlot === registration.secretSlot &&
    JSON.stringify(target.renewal) === JSON.stringify(registration.renewal)
  );
}

interface WebhookUseClaims {
  readonly version: 1;
  readonly attemptId: string;
  readonly integrationId: string;
  readonly credentialSlot: string;
  readonly reference: `secret://${string}`;
}

type CompiledOimTool =
  | CompiledOimHttpTool
  | CompiledOimGraphqlTool
  | CompiledOimOpenApiTool
  | CompiledOimCompositeTool;

function manifestMajor(manifest: OimManifest): number {
  return Number.parseInt(manifest.metadata.version.split(".", 1)[0] ?? "", 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InternalOimWorkerRouteError(400, code);
  }
  return value;
}

function secretReference(value: string): value is `secret://${string}` {
  return value.startsWith("secret://") && value.length > "secret://".length;
}

function packageList(
  integrations: Iterable<readonly [string, SoulIntegration]>
): readonly ActiveOimPackage[] {
  return [...integrations].flatMap(([key, integration]) =>
    integration.oimManifest === undefined
      ? []
      : [{ key, integration, manifest: integration.oimManifest }]
  );
}

function exactlyOne(
  packages: readonly ActiveOimPackage[],
  predicate: (pkg: ActiveOimPackage) => boolean
): ActiveOimPackage | null {
  const matches = packages.filter(predicate);
  if (matches.length > 1) {
    throw new InternalOimWorkerRouteError(409, "oim_manifest_ambiguous");
  }
  return matches[0] ?? null;
}

function compiledOperation(
  pkg: ActiveOimPackage,
  configuration: Readonly<Record<string, string | number | boolean>>,
  operationId: string
): CompiledOimTool {
  const documents = new Map(Object.entries(pkg.integration.oimDocuments ?? {}));
  const openApiDocuments = new Map(Object.entries(pkg.integration.oimOpenApiDocuments ?? {}));
  const compiled = [
    ...compileOimHttpOperations(pkg.manifest, configuration),
    ...compileOimGraphqlOperations(pkg.manifest, documents, configuration),
    ...compileOimOpenApiOperations(pkg.manifest, openApiDocuments, configuration),
    ...compileOimCompositeOperations(pkg.manifest, documents, openApiDocuments, configuration),
  ];
  const operation = compiled.find((candidate) => candidate.operation.id === operationId);
  if (operation === undefined) {
    throw new InternalOimWorkerRouteError(404, "oim_operation_not_found");
  }
  return operation;
}

function destinationOf(tool: CompiledOimTool): string {
  if ("url" in tool.binding) return tool.binding.url;
  if ("baseUrl" in tool.binding) return tool.binding.baseUrl;
  throw new InternalOimWorkerRouteError(409, "oim_operation_binding_mismatch");
}

function adapterOf(
  tool: CompiledOimTool,
  deps: Pick<InternalOimWorkerHostDeps, "http" | "paginationRuntime">,
  manifest: OimManifest,
  hookRunner: OimHookPhaseRunner
): ToolAdapter {
  if (tool.operation.source.type === "composite") {
    const composite = tool as CompiledOimCompositeTool;
    return new OimCompositeToolAdapter({
      steps: composite.steps.map((step) => ({
        ...step,
        adapter: adapterOf(step.tool, deps, manifest, hookRunner),
        contract: step.tool.contract,
      })),
    });
  }
  if (tool.operation.source.type === "graphql") {
    const graphqlTool = tool as CompiledOimGraphqlTool;
    if (!("document" in graphqlTool.binding)) {
      throw new InternalOimWorkerRouteError(409, "oim_operation_binding_mismatch");
    }
    return new OimGraphqlToolAdapter({
      binding: graphqlTool.binding,
      http: deps.http,
      manifest,
      hookRunner,
      toolId: graphqlTool.contract.spec.toolId,
      ...(graphqlTool.projection === undefined ? {} : { projection: graphqlTool.projection }),
      ...(graphqlTool.pagination === undefined
        ? {}
        : { pagination: graphqlTool.pagination, paginationRuntime: deps.paginationRuntime }),
    });
  }
  const httpTool = tool as CompiledOimHttpTool | CompiledOimOpenApiTool;
  if (!("pathTemplate" in httpTool.binding)) {
    throw new InternalOimWorkerRouteError(409, "oim_operation_binding_mismatch");
  }
  return new OimHttpToolAdapter({
    binding: httpTool.binding,
    http: deps.http,
    manifest,
    hookRunner,
    toolId: httpTool.contract.spec.toolId,
    ...(httpTool.projection === undefined ? {} : { projection: httpTool.projection }),
    ...(httpTool.pagination === undefined
      ? {}
      : { pagination: httpTool.pagination, paginationRuntime: deps.paginationRuntime }),
  });
}

function setPointer(target: Record<string, unknown>, pointer: string, value: unknown): void {
  const segments = pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  let parent = target;
  for (const segment of segments.slice(0, -1)) {
    const child = parent[segment];
    if (child === undefined) {
      const created: Record<string, unknown> = {};
      parent[segment] = created;
      parent = created;
      continue;
    }
    if (!isRecord(child)) {
      throw new InternalOimWorkerRouteError(409, "oim_webhook_binding_invalid");
    }
    parent = child;
  }
  const leaf = segments.at(-1);
  if (leaf === undefined || Object.hasOwn(parent, leaf)) {
    throw new InternalOimWorkerRouteError(409, "oim_webhook_binding_invalid");
  }
  parent[leaf] = value;
}

function bindWebhookValue(
  arguments_: Record<string, unknown>,
  binding:
    | { readonly in: "body"; readonly pointer: string }
    | {
        readonly in: "parameter";
        readonly name: string;
      },
  value: string
): void {
  if (binding.in === "parameter") {
    if (Object.hasOwn(arguments_, binding.name)) {
      throw new InternalOimWorkerRouteError(409, "oim_webhook_binding_invalid");
    }
    arguments_[binding.name] = value;
    return;
  }
  setPointer(arguments_, binding.pointer, value);
}

function withoutPageToken(value: unknown): {
  readonly body: unknown;
  readonly nextPageToken?: string;
} {
  if (!isRecord(value) || !(NEXT_PAGE_TOKEN_PROPERTY in value)) return { body: value };
  const nextPageToken = value[NEXT_PAGE_TOKEN_PROPERTY];
  if (typeof nextPageToken !== "string" || nextPageToken.length === 0) {
    throw new InternalOimWorkerRouteError(409, "oim_page_token_invalid");
  }
  const body = { ...value };
  delete body[NEXT_PAGE_TOKEN_PROPERTY];
  return { body, nextPageToken };
}

function webhookStep(
  manifest: OimManifest,
  stepId: string
): Extract<NonNullable<OimManifest["auth"]>["steps"][number], { type: "webhook" }> {
  const step = manifest.auth?.steps.find(
    (candidate) => candidate.type === "webhook" && candidate.id === stepId
  );
  if (step?.type !== "webhook") {
    throw new InternalOimWorkerRouteError(404, "oim_webhook_step_not_found");
  }
  return step;
}

function webhookExpiration(
  step: Extract<NonNullable<OimManifest["auth"]>["steps"][number], { type: "webhook" }>,
  response: unknown
): string | undefined {
  if (step.renewal === undefined) return undefined;
  const expiresAt = requiredString(
    readPointer(response, step.renewal.expiresAtPath),
    "oim_webhook_expiration_invalid"
  );
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new InternalOimWorkerRouteError(409, "oim_webhook_expiration_invalid");
  }
  return expiresAt;
}

function webhookReference(attemptId: string): `secret://${string}` {
  const digest = createHash("sha256")
    .update("tulipfarm-oim-webhook-attempt-v1\0")
    .update(attemptId)
    .digest("hex");
  const variant = (Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8;
  return `secret://${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(
    13,
    16
  )}-${variant.toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function payloadEnvelope(value: string): SecretEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new InternalOimWorkerRouteError(400, "oim_payload_invalid");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.encryptedValue !== "string" ||
    typeof parsed.iv !== "string" ||
    typeof parsed.authTag !== "string"
  ) {
    throw new InternalOimWorkerRouteError(400, "oim_payload_invalid");
  }
  return {
    encryptedValue: parsed.encryptedValue,
    iv: parsed.iv,
    authTag: parsed.authTag,
  };
}

export class InternalOimWorkerHost implements InternalOimWorkerRouteDeps {
  private readonly now: () => Date;
  private readonly webhookTokenKey: Buffer;

  constructor(private readonly deps: InternalOimWorkerHostDeps) {
    this.now = deps.now ?? (() => new Date());
    this.webhookTokenKey = createHmac("sha256", deps.payloadKey)
      .update(WEBHOOK_TOKEN_DOMAIN)
      .digest();
  }

  async listPollingRegistrations() {
    const packages = packageList(this.deps.integrations());
    const connections = await this.deps.connections.listPollingFallbacks();
    const registrations = await Promise.all(
      connections.map(async (connection) => {
        const pkg = exactlyOne(
          packages,
          (candidate) =>
            candidate.manifest.metadata.id === connection.integration.id &&
            manifestMajor(candidate.manifest) === connection.integration.majorVersion
        );
        if (pkg?.manifest.ingress?.kind !== "polling") return null;
        const current = await this.deps.connections.findById(connection.businessId, connection.id);
        if (current === null) return null;
        return {
          businessId: connection.businessId,
          connectionId: connection.id,
          integrationId: connection.integration.id,
          integrationMajorVersion: connection.integration.majorVersion,
        };
      })
    );
    return registrations.filter((value): value is NonNullable<typeof value> => value !== null);
  }

  async resolveConnectionManifest(
    input: Parameters<InternalOimWorkerRouteDeps["resolveConnectionManifest"]>[0]
  ) {
    const connection = await this.deps.connections.findById(input.businessId, input.connectionId);
    if (
      connection === null ||
      connection.integration.id !== input.integrationId ||
      connection.integration.majorVersion !== input.integrationMajorVersion
    ) {
      return null;
    }
    return this.packageByIdentity(input.integrationId, input.integrationMajorVersion);
  }

  async resolveIntegrationManifest(
    input: Parameters<InternalOimWorkerRouteDeps["resolveIntegrationManifest"]>[0]
  ) {
    if (input.businessId.length === 0) return null;
    return this.packageByIdentity(input.integrationId, input.integrationMajorVersion);
  }

  async resolveRegistrationManifest(integrationKey: string) {
    const pkg = exactlyOne(packageList(this.deps.integrations()), (candidate) => {
      return candidate.key === integrationKey;
    });
    return pkg === null ? null : { integrationKey: pkg.key, manifest: pkg.manifest };
  }

  async executePollingOperation(
    input: Parameters<InternalOimWorkerRouteDeps["executePollingOperation"]>[0]
  ) {
    const pkg = await this.exactConnectionPackage(input);
    if (
      input.purpose !== "ingress_poll" ||
      pkg.manifest.ingress?.kind !== "polling" ||
      pkg.manifest.ingress.operationId !== input.operationId
    ) {
      throw new InternalOimWorkerRouteError(409, "oim_polling_operation_mismatch");
    }
    const parameters: Record<string, unknown> = {};
    if (input.cursor !== null) {
      parameters[pkg.manifest.ingress.cursor.requestParameter] = input.cursor;
    }
    const identity = await this.verifiedIdentity(input, pkg);
    const response = await this.executeOperation(pkg, input, parameters, input.leaseToken);
    await this.assertIdentityCurrent(input, pkg, identity.proofDigest);
    return {
      response,
      authenticatedEvidenceDigest: canonicalHash({
        kind: "oim_authenticated_polling_response",
        version: 1,
        manifestDigest: input.expectedManifestDigest,
        connectionId: input.connectionId,
        operationId: input.operationId,
        leaseToken: input.leaseToken,
        identityProofDigest: identity.proofDigest,
        response,
      }),
      verifiedIdentity: {
        externalTenantId: identity.externalTenantId,
        externalAccountId: identity.externalAccountId,
      },
    };
  }

  async executeKnowledgeOperation(
    input: Parameters<InternalOimWorkerRouteDeps["executeKnowledgeOperation"]>[0]
  ) {
    const pkg = await this.exactConnectionPackage(input);
    if (input.purpose !== "knowledge_sync" || pkg.manifest.knowledge === undefined) {
      throw new InternalOimWorkerRouteError(409, "oim_knowledge_operation_mismatch");
    }
    const identity = await this.verifiedIdentity(input, pkg);
    const parameters = {
      ...input.parameters,
      ...(input.pageToken === undefined ? {} : { [PAGE_TOKEN_ARGUMENT]: input.pageToken }),
    };
    const response = await this.executeOperation(pkg, input, parameters, input.operationId);
    await this.assertIdentityCurrent(input, pkg, identity.proofDigest);
    return withoutPageToken(response);
  }

  stageWebhookCredential: InternalOimWorkerRouteDeps["stageWebhookCredential"] = async (input) => {
    const reference = webhookReference(input.attemptId);
    if (input.existingRef !== null && input.existingRef !== reference) {
      throw new InternalOimWorkerRouteError(409, "oim_webhook_secret_reference_mismatch");
    }
    const storageKey = secretStorageKey(reference);
    const existing = await this.deps.secrets.get(storageKey).catch(() => undefined);
    if (existing === undefined) {
      await this.deps.secrets.set(storageKey, randomBytes(32).toString("base64url"));
    }
    const claims: WebhookUseClaims = {
      version: 1,
      attemptId: input.attemptId,
      integrationId: input.integrationId,
      credentialSlot: input.credentialSlot,
      reference,
    };
    return {
      ref: reference,
      use: async <T>(fn: (secret: string) => Promise<T> | T) =>
        fn(signToken(this.webhookTokenKey, claims)),
    };
  };

  revokeWebhookCredential: InternalOimWorkerRouteDeps["revokeWebhookCredential"] = async (
    reference
  ) => {
    if (!WEBHOOK_SECRET_REFERENCE.test(reference)) {
      throw new InternalOimWorkerRouteError(400, "oim_webhook_secret_reference_invalid");
    }
    await this.deps.secrets.delete(secretStorageKey(reference));
  };

  revokeWebhookCredentialAttempt: InternalOimWorkerRouteDeps["revokeWebhookCredentialAttempt"] =
    async (attemptId) => {
      await this.deps.secrets.delete(secretStorageKey(webhookReference(attemptId)));
    };

  registerWebhook: WebhookRegistrationProvider["register"] = async (input) => {
    const pkg = this.registrationPackage(input.claim.target);
    if (canonicalHash(input.manifest) !== canonicalHash(pkg.manifest)) {
      throw new InternalOimWorkerRouteError(409, "oim_webhook_manifest_mismatch");
    }
    const step = webhookStep(pkg.manifest, input.claim.target.stepId);
    if (
      step.operationId !== input.claim.target.operationId ||
      step.unregisterOperationId !== input.claim.target.unregisterOperationId ||
      step.secretSlot !== input.claim.target.secretSlot ||
      input.callbackUrl !== input.claim.target.callbackUrl
    ) {
      throw new InternalOimWorkerRouteError(409, "oim_webhook_target_mismatch");
    }
    const claims = this.webhookUseClaims(input.secret);
    if (
      claims.attemptId !== input.idempotencyKey ||
      claims.integrationId !== input.claim.integrationId ||
      claims.credentialSlot !== step.secretSlot
    ) {
      throw new InternalOimWorkerRouteError(409, "oim_webhook_use_token_mismatch");
    }
    const secret = await this.deps.secrets.get(secretStorageKey(claims.reference));
    const arguments_: Record<string, unknown> = {};
    bindWebhookValue(arguments_, step.registration.callbackUrl, input.callbackUrl);
    if (step.registration.secret !== undefined) {
      bindWebhookValue(arguments_, step.registration.secret, secret);
    }
    const identity = await this.verifiedIdentity(input.claim, pkg);
    const response = await this.executeOperation(
      pkg,
      {
        businessId: input.claim.businessId,
        connectionId: input.claim.connectionId,
        integrationId: input.claim.integrationId,
        integrationMajorVersion: input.claim.integrationMajorVersion,
        operationId: step.operationId,
        expectedManifestDigest: input.claim.target.manifestDigest,
      },
      arguments_,
      input.idempotencyKey
    );
    const subscriptionId = requiredString(
      readPointer(response, step.subscriptionIdPath),
      "oim_webhook_subscription_id_invalid"
    );
    await this.assertIdentityCurrent(input.claim, pkg, identity.proofDigest);
    return this.webhookResult(
      pkg,
      step.operationId,
      subscriptionId,
      identity,
      response,
      webhookExpiration(step, response)
    );
  };

  reconcileWebhook: WebhookRegistrationProvider["reconcile"] = async (input) => {
    try {
      const pkg = this.registrationPackage(input.attempt.target);
      const step = webhookStep(pkg.manifest, input.attempt.target.stepId);
      const secret = await this.deps.secrets.get(secretStorageKey(input.attempt.secretRef));
      const arguments_: Record<string, unknown> = {};
      bindWebhookValue(arguments_, step.registration.callbackUrl, input.attempt.target.callbackUrl);
      if (step.registration.secret !== undefined) {
        bindWebhookValue(arguments_, step.registration.secret, secret);
      }
      const identity = await this.verifiedIdentity(input.attempt, pkg);
      const response = await this.executeOperation(
        pkg,
        {
          businessId: input.attempt.businessId,
          connectionId: input.attempt.connectionId,
          integrationId: input.attempt.integrationId,
          integrationMajorVersion: input.attempt.integrationMajorVersion,
          operationId: step.operationId,
          expectedManifestDigest: input.attempt.target.manifestDigest,
        },
        arguments_,
        input.idempotencyKey
      );
      const subscriptionId = requiredString(
        readPointer(response, step.subscriptionIdPath),
        "oim_webhook_subscription_id_invalid"
      );
      await this.assertIdentityCurrent(input.attempt, pkg, identity.proofDigest);
      return {
        kind: "active",
        result: this.webhookResult(
          pkg,
          step.operationId,
          subscriptionId,
          identity,
          response,
          webhookExpiration(step, response)
        ),
      };
    } catch (error) {
      return {
        kind: "unknown",
        reason:
          error instanceof InternalOimWorkerRouteError
            ? error.code
            : "oim_webhook_reconciliation_failed",
      };
    }
  };

  renewWebhook: WebhookRegistrationProvider["renew"] = async (input) => {
    const pkg = this.registrationPackage(input.claim.target);
    if (canonicalHash(input.manifest) !== canonicalHash(pkg.manifest)) {
      throw new InternalOimWorkerRouteError(409, "oim_webhook_manifest_mismatch");
    }
    const step = webhookStep(pkg.manifest, input.claim.target.stepId);
    const renewal = step.renewal;
    if (
      renewal === undefined ||
      input.claim.target.renewal === undefined ||
      !sameWebhookTarget(input.claim.target, input.registration) ||
      renewal.operationId !== input.claim.target.renewal.operationId ||
      JSON.stringify(renewal.subscriptionId) !==
        JSON.stringify(input.claim.target.renewal.subscriptionId) ||
      renewal.expiresAtPath !== input.claim.target.renewal.expiresAtPath ||
      renewal.renewBeforeSeconds !== input.claim.target.renewal.renewBeforeSeconds
    ) {
      throw new InternalOimWorkerRouteError(409, "oim_webhook_target_mismatch");
    }
    const arguments_: Record<string, unknown> = {};
    bindWebhookValue(arguments_, renewal.subscriptionId, input.registration.subscriptionId);
    const identity = await this.verifiedIdentity(input.claim, pkg);
    try {
      const response = await this.executeOperation(
        pkg,
        {
          businessId: input.claim.businessId,
          connectionId: input.claim.connectionId,
          integrationId: input.claim.integrationId,
          integrationMajorVersion: input.claim.integrationMajorVersion,
          operationId: renewal.operationId,
          expectedManifestDigest: input.claim.target.manifestDigest,
        },
        arguments_,
        input.idempotencyKey
      );
      await this.assertIdentityCurrent(input.claim, pkg, identity.proofDigest);
      return {
        kind: "renewed" as const,
        result: this.webhookResult(
          pkg,
          renewal.operationId,
          input.registration.subscriptionId,
          identity,
          response,
          webhookExpiration(step, response)
        ),
      };
    } catch (error) {
      if (error instanceof AdapterDispatchError && error.code === "provider_not_found") {
        return { kind: "settled_absent" as const };
      }
      throw error;
    }
  };

  unregisterWebhook: WebhookRegistrationProvider["unregister"] = async (input) => {
    const { cleanupAuthorization, cleanupConnectionOperations } = this.deps;
    if (cleanupAuthorization === undefined || cleanupConnectionOperations === undefined) {
      throw new InternalOimWorkerRouteError(503, "oim_webhook_cleanup_unavailable");
    }
    const cleanup = await cleanupAuthorization.authorize(input, this.now());
    if (
      cleanup === null ||
      input.registration.secretRef !==
        webhookReference(
          [input.key.businessId, input.key.connectionId, "register", cleanup.generation].join(":")
        )
    ) {
      throw new InternalOimWorkerRouteError(409, "oim_webhook_cleanup_not_authorized");
    }
    let resolved: { readonly key: string; readonly integration: SoulIntegration };
    try {
      resolved = (this.deps.cleanupPackages?.load ?? loadOimWebhookCleanupPackage)(
        input.target.integrationKey,
        input.target.packageSnapshot
      );
    } catch {
      throw new InternalOimWorkerRouteError(409, "oim_webhook_cleanup_package_mismatch");
    }
    const pkg = this.exactCleanupPackage(resolved, input.key, input.target);
    const step = webhookStep(pkg.manifest, input.target.stepId);
    if (
      !sameWebhookTarget(input.target, input.registration) ||
      step.operationId !== input.target.operationId ||
      step.unregisterOperationId !== input.target.unregisterOperationId
    ) {
      throw new InternalOimWorkerRouteError(409, "oim_webhook_target_mismatch");
    }
    const arguments_: Record<string, unknown> = {};
    bindWebhookValue(
      arguments_,
      step.unregistration.subscriptionId,
      input.registration.subscriptionId
    );
    await this.executeOperation(
      pkg,
      {
        businessId: input.key.businessId,
        connectionId: input.key.connectionId,
        integrationId: input.key.integrationId,
        integrationMajorVersion: input.key.integrationMajorVersion,
        operationId: step.unregisterOperationId,
        expectedManifestDigest: input.target.manifestDigest,
      },
      arguments_,
      input.idempotencyKey,
      cleanupConnectionOperations,
      true
    );
  };

  async encryptPayload(payload: Buffer): Promise<string> {
    const envelope = encryptSecret(payload.toString("base64"), this.deps.payloadKey);
    return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  }

  async decryptPayload(encryptedPayload: string): Promise<Buffer> {
    try {
      return Buffer.from(
        decryptSecret(payloadEnvelope(encryptedPayload), { current: this.deps.payloadKey }),
        "base64"
      );
    } catch (error) {
      if (error instanceof InternalOimWorkerRouteError) throw error;
      throw new InternalOimWorkerRouteError(400, "oim_payload_invalid");
    }
  }

  async runHook(input: Parameters<InternalOimWorkerRouteDeps["runHook"]>[0]): Promise<unknown> {
    const pkg = this.activePackageByIdentity(input.integrationId, input.integrationMajorVersion);
    const requestedHook = input.hook;
    if (pkg === null || input.businessId.length === 0 || !isRecord(requestedHook)) {
      throw new InternalOimWorkerRouteError(404, "oim_hook_not_found");
    }
    const hook = pkg.manifest.hooks?.find(
      (candidate) =>
        candidate.kind === requestedHook.kind &&
        candidate.file === requestedHook.file &&
        candidate.export === requestedHook.export
    );
    if (hook === undefined) throw new InternalOimWorkerRouteError(404, "oim_hook_not_found");
    return this.hookRunner(pkg, input.businessId).run(hook, input.phaseInput as never);
  }

  async listKnowledgeRegistrations() {
    const registrations = await this.deps.knowledgeRegistrations.list();
    const results = await Promise.all(
      registrations.map(async (registration) => {
        const pkg = exactlyOne(
          packageList(this.deps.integrations()),
          (candidate) =>
            candidate.key === registration.integrationSlug &&
            candidate.manifest.metadata.id === registration.integrationId &&
            manifestMajor(candidate.manifest) === registration.integrationMajorVersion &&
            candidate.manifest.knowledge?.sourceKinds.some(
              (source) => source.id === registration.sourceKindId
            ) === true
        );
        if (pkg === null) return null;
        const connection = await this.deps.connections.findById(
          registration.businessId,
          registration.connectionId
        );
        if (
          connection === null ||
          connection.integration.id !== registration.integrationId ||
          connection.integration.majorVersion !== registration.integrationMajorVersion
        ) {
          return null;
        }
        const identity = await this.verifiedIdentity(registration, pkg).catch(() => null);
        if (identity === null) return null;
        const options: OimKnowledgeSyncOptions = {
          businessId: registration.businessId,
          integrationSlug: registration.integrationSlug,
          connectionId: registration.connectionId,
          sourceKindId: registration.sourceKindId,
          scopes: registration.scopes,
          ...(registration.classification === undefined
            ? {}
            : { classification: registration.classification }),
          ...(registration.aclMaximumAgeSeconds === undefined
            ? {}
            : { aclMaximumAgeSeconds: registration.aclMaximumAgeSeconds }),
          ...(registration.liveMaximumAgeSeconds === undefined
            ? {}
            : { liveMaximumAgeSeconds: registration.liveMaximumAgeSeconds }),
        };
        return {
          id: canonicalHash(options),
          manifest: pkg.manifest,
          manifestDigest: canonicalHash(pkg.manifest),
          options,
          verifiedIdentity: {
            externalTenantId: identity.externalTenantId,
            externalAccountId: identity.externalAccountId,
          },
        };
      })
    );
    return results.filter((value): value is NonNullable<typeof value> => value !== null);
  }

  async resolveKnowledgeIdentities(
    input: Parameters<InternalOimWorkerRouteDeps["resolveKnowledgeIdentities"]>[0],
    entries: readonly ProviderAclEntry[]
  ) {
    const pkg = this.activePackageByIdentity(input.integrationId, input.integrationMajorVersion);
    if (pkg === null) throw new InternalOimWorkerRouteError(404, "oim_manifest_not_found");
    const identity = await this.verifiedIdentity(input, pkg);
    if (
      identity.externalTenantId !== input.externalTenantId ||
      identity.externalAccountId !== input.externalAccountId
    ) {
      throw new InternalOimWorkerRouteError(409, "oim_connection_identity_mismatch");
    }
    const principals = new Map<string, { readonly kind: string; readonly id: string }>();
    let incomplete = false;
    for (const entry of entries) {
      if (entry.kind === "public") {
        principals.set(
          `${BLANKET_READ_PRINCIPAL.kind}:${BLANKET_READ_PRINCIPAL.id}`,
          BLANKET_READ_PRINCIPAL
        );
        continue;
      }
      if (entry.kind !== "user" || entry.id === undefined) {
        incomplete = true;
        continue;
      }
      const mapping = await this.deps.externalIdentities.findMapping(
        input.integrationId,
        entry.id,
        input.externalTenantId
      );
      if (
        mapping === null ||
        !isProvenLink(mapping) ||
        (mapping.expiresAt !== null && mapping.expiresAt <= this.now())
      ) {
        incomplete = true;
        continue;
      }
      principals.set(`user:${mapping.userId}`, { kind: "user", id: mapping.userId });
    }
    return { principals: [...principals.values()], incomplete };
  }

  private packageByIdentity(integrationId: string, majorVersion: number) {
    const pkg = this.activePackageByIdentity(integrationId, majorVersion);
    return pkg === null ? null : { integrationKey: pkg.key, manifest: pkg.manifest };
  }

  private activePackageByIdentity(
    integrationId: string,
    majorVersion: number
  ): ActiveOimPackage | null {
    return exactlyOne(
      packageList(this.deps.integrations()),
      (candidate) =>
        candidate.manifest.metadata.id === integrationId &&
        manifestMajor(candidate.manifest) === majorVersion
    );
  }

  private registrationPackage(target: {
    readonly integrationKey: string;
    readonly manifestDigest: string;
  }): ActiveOimPackage {
    const pkg = exactlyOne(
      packageList(this.deps.integrations()),
      (candidate) => candidate.key === target.integrationKey
    );
    if (pkg === null || canonicalHash(pkg.manifest) !== target.manifestDigest) {
      throw new InternalOimWorkerRouteError(404, "oim_manifest_not_found");
    }
    return pkg;
  }

  private exactCleanupPackage(
    resolved: { readonly key: string; readonly integration: SoulIntegration },
    key: WebhookRegistrationKey,
    target: WebhookRegistrationTarget
  ): ActiveOimPackage {
    const manifest = resolved.integration.oimManifest;
    if (
      manifest === undefined ||
      resolved.integration.slug !== target.integrationKey ||
      manifest.metadata.id !== key.integrationId ||
      manifestMajor(manifest) !== key.integrationMajorVersion ||
      canonicalHash(manifest) !== target.manifestDigest
    ) {
      throw new InternalOimWorkerRouteError(409, "oim_webhook_cleanup_package_mismatch");
    }
    return { key: resolved.key, integration: resolved.integration, manifest };
  }

  private async exactConnectionPackage(input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly integrationId: string;
    readonly integrationMajorVersion: number;
    readonly expectedManifestDigest: string;
  }): Promise<ActiveOimPackage> {
    const connection = await this.deps.connections.findById(input.businessId, input.connectionId);
    if (
      connection === null ||
      connection.integration.id !== input.integrationId ||
      connection.integration.majorVersion !== input.integrationMajorVersion
    ) {
      throw new InternalOimWorkerRouteError(404, "oim_connection_not_found");
    }
    const pkg = exactlyOne(
      packageList(this.deps.integrations()),
      (candidate) =>
        candidate.manifest.metadata.id === input.integrationId &&
        manifestMajor(candidate.manifest) === input.integrationMajorVersion
    );
    if (pkg === null || canonicalHash(pkg.manifest) !== input.expectedManifestDigest) {
      throw new InternalOimWorkerRouteError(409, "oim_manifest_changed");
    }
    return pkg;
  }

  private async verifiedIdentity(
    input: {
      readonly businessId: string;
      readonly connectionId: string;
      readonly integrationId: string;
      readonly integrationMajorVersion: number;
    },
    pkg: ActiveOimPackage
  ) {
    const evidence = await this.deps.verificationEvidence.findCurrentForConnection(
      input.businessId,
      input.connectionId,
      oimPackageDigest(pkg.manifest)
    );
    const identity = evidence === null ? null : projectVerifiedConnectionIdentity(evidence);
    if (identity === null) {
      throw new InternalOimWorkerRouteError(409, "oim_connection_identity_unverified");
    }
    return identity;
  }

  private async assertIdentityCurrent(
    input: {
      readonly businessId: string;
      readonly connectionId: string;
      readonly integrationId: string;
      readonly integrationMajorVersion: number;
    },
    pkg: ActiveOimPackage,
    proofDigest: string
  ): Promise<void> {
    const current = await this.verifiedIdentity(input, pkg);
    if (current.proofDigest !== proofDigest) {
      throw new InternalOimWorkerRouteError(409, "oim_connection_identity_changed");
    }
  }

  private hookRunner(pkg: ActiveOimPackage, businessId: string): OimHookPhaseRunner {
    return {
      run: async (hook, input) => {
        if (this.deps.hookExecutor === undefined) {
          throw new InternalOimWorkerRouteError(503, "oim_hook_runtime_unavailable");
        }
        const content = pkg.integration.oimPackageFiles?.[hook.file];
        const file = pkg.manifest.files?.find(
          (candidate) => candidate.path === hook.file && candidate.role === "hook"
        );
        if (content === undefined || file === undefined) {
          throw new InternalOimWorkerRouteError(503, "oim_hook_runtime_unavailable");
        }
        const source =
          typeof content === "string" ? content : Buffer.from(content).toString("utf8");
        return this.deps.hookExecutor.runPureHook({
          source,
          sourceSha256: file.sha256,
          exportName: hook.export,
          input,
          breakerKey: [
            "oim",
            businessId,
            pkg.key,
            canonicalHash(pkg.manifest),
            hook.kind,
            hook.export,
          ].join(":"),
        });
      },
    };
  }

  private async executeOperation(
    pkg: ActiveOimPackage,
    input: {
      readonly businessId: string;
      readonly connectionId: string;
      readonly integrationId: string;
      readonly integrationMajorVersion: number;
      readonly operationId: string;
      readonly expectedManifestDigest: string;
    },
    arguments_: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
    connectionOperations = this.deps.connectionOperations,
    cleanupAuthorized = false
  ): Promise<unknown> {
    const operation = pkg.manifest.operations.find(
      (candidate) => candidate.id === input.operationId
    );
    if (operation === undefined) {
      throw new InternalOimWorkerRouteError(404, "oim_operation_not_found");
    }
    const resolution = await connectionOperations.resolve({
      businessId: input.businessId,
      manifest: pkg.manifest,
      operation,
      principal: WORKER_PRINCIPAL,
      connectionId: input.connectionId,
      requireExplicitConnection: true,
    });
    if (
      resolution.kind !== "public" &&
      resolution.kind !== "configured" &&
      resolution.kind !== "ready"
    ) {
      throw new InternalOimWorkerRouteError(409, `oim_connection_${resolution.kind}`);
    }
    const connection =
      resolution.kind === "public"
        ? await this.deps.connections.findById(input.businessId, input.connectionId)
        : resolution.connection;
    if (connection === null) {
      throw new InternalOimWorkerRouteError(404, "oim_connection_not_found");
    }
    const tool = compiledOperation(pkg, connection.configuration, operation.id);
    const adapter = adapterOf(
      tool,
      this.deps,
      pkg.manifest,
      this.hookRunner(pkg, input.businessId)
    );
    const credentialRevision =
      resolution.kind === "ready"
        ? await this.deps.secrets.revision(secretStorageKey(resolution.credentialRef))
        : null;
    const secondaryCredentialRevision =
      resolution.kind === "ready" && resolution.secondaryCredentialRef !== undefined
        ? await this.deps.secrets.revision(secretStorageKey(resolution.secondaryCredentialRef))
        : null;
    if (
      resolution.kind === "ready" &&
      (credentialRevision === null ||
        (resolution.secondaryCredentialRef !== undefined &&
          (resolution.secondaryBinding === undefined || secondaryCredentialRevision === null)))
    ) {
      throw new InternalOimWorkerRouteError(409, "oim_connection_credential_required");
    }
    const readyCredentialRevision = credentialRevision ?? undefined;
    const readySecondaryCredentialRevision = secondaryCredentialRevision ?? undefined;
    const now = this.now().toISOString();
    const intent = {
      intentId: canonicalHash({ ...input, idempotencyKey }),
      businessId: input.businessId,
      runId: `oim-worker:${idempotencyKey}`,
      stateId: input.operationId,
      toolId: tool.contract.spec.toolId,
      toolVersion: pkg.manifest.metadata.version,
      action: operation.effect,
      targetRefs: [],
      arguments: arguments_,
      principalKind: WORKER_PRINCIPAL.kind,
      principalId: WORKER_PRINCIPAL.id,
      integrationId: input.integrationId,
      integrationMajorVersion: input.integrationMajorVersion,
      operationId: input.operationId,
      manifestDigest: input.expectedManifestDigest,
      configurationDigest: canonicalHash(connection.configuration),
      destination: destinationOf(tool),
      ...(resolution.kind === "ready"
        ? {
            credentialRef: resolution.credentialRef,
            connection: { ...resolution.binding, credentialRevision: readyCredentialRevision },
            ...(resolution.secondaryCredentialRef === undefined ||
            resolution.secondaryBinding === undefined
              ? {}
              : {
                  secondaryCredentialRef: resolution.secondaryCredentialRef,
                  secondaryConnection: {
                    ...resolution.secondaryBinding,
                    credentialRevision: readySecondaryCredentialRevision,
                  },
                }),
          }
        : {}),
      idempotencyKey,
    };
    const request = { intent, idempotencyKey, attempt: 1 };
    const effect: EffectRecord = {
      effectId: intent.intentId,
      businessId: input.businessId,
      runId: intent.runId,
      stateId: intent.stateId,
      logicalEffectOrdinal: 0,
      idempotencyKey,
      intentDigest: canonicalHash(intent),
      intent,
      guardrailRevision: "oim-worker-v1",
      state: "authorized",
      outputStored: false,
      output: undefined,
      createdAt: now,
      updatedAt: now,
    };
    const dispatch = () =>
      resolution.kind !== "ready"
        ? adapter.dispatch(request)
        : this.dispatchWithCredentials(
            input,
            pkg,
            operation,
            effect,
            adapter,
            request,
            connectionOperations
          );
    if (cleanupAuthorized) return dispatch();
    let settlement: OimDispatchSettlement = "not_dispatched";
    return this.deps.releaseDispatch.dispatch(
      { businessId: input.businessId, integration: pkg.integration },
      async (providerDispatch) => {
        try {
          const result = await providerDispatch(dispatch);
          settlement = "settled";
          return result;
        } catch (error) {
          settlement =
            error instanceof AdapterDispatchError
              ? error.phase === "before_dispatch"
                ? "not_dispatched"
                : tool.contract.spec.mutating
                  ? "ambiguous"
                  : "settled"
              : "ambiguous";
          throw error;
        }
      },
      async () => settlement
    );
  }

  private async dispatchWithCredentials(
    input: {
      readonly businessId: string;
      readonly connectionId: string;
      readonly integrationId: string;
      readonly integrationMajorVersion: number;
      readonly operationId: string;
    },
    pkg: ActiveOimPackage,
    operation: OimManifest["operations"][number],
    effect: EffectRecord,
    adapter: ToolAdapter,
    request: {
      readonly intent: EffectRecord["intent"];
      readonly idempotencyKey: string;
      readonly attempt: number;
    },
    connectionOperations: OimOperationConnectionResolver
  ): Promise<unknown> {
    const provider = secretsServiceProvider(this.deps.secrets);
    const dispatcher = new CredentialDispatcher({
      secrets: new SecretBroker({
        provider,
        authorizer: {
          authorize: (scope) =>
            scope.businessId === input.businessId &&
            scope.connectionId === input.connectionId &&
            scope.integrationId === input.integrationId &&
            scope.integrationMajorVersion === input.integrationMajorVersion &&
            scope.operationId === input.operationId &&
            scope.principalKind === WORKER_PRINCIPAL.kind &&
            scope.principalId === WORKER_PRINCIPAL.id
              ? { allowed: true, maxTtlMs: 60_000, maxUses: 1 }
              : { allowed: false, reason: "not_authorized" },
        },
      }),
      reauthorize: async (current) => {
        const binding = current.intent.connection;
        const reference = current.intent.credentialRef;
        if (binding === undefined || !secretReference(reference ?? "")) return false;
        if (
          (await connectionOperations.reauthorizeConnection(
            input.businessId,
            pkg.manifest,
            operation,
            binding,
            reference as `secret://${string}`
          )) === null
        ) {
          return false;
        }
        const secondaryBinding = current.intent.secondaryConnection;
        const secondaryReference = current.intent.secondaryCredentialRef;
        return (
          (secondaryBinding === undefined && secondaryReference === undefined) ||
          (secondaryBinding !== undefined &&
            secretReference(secondaryReference ?? "") &&
            (await connectionOperations.reauthorizeConnection(
              input.businessId,
              pkg.manifest,
              operation,
              secondaryBinding,
              secondaryReference as `secret://${string}`
            )) !== null)
        );
      },
    });
    return dispatcher.dispatch(effect, adapter, request);
  }

  private webhookUseClaims(token: string): WebhookUseClaims {
    const claims = verifyToken<Partial<WebhookUseClaims>>(this.webhookTokenKey, token);
    if (
      claims?.version !== 1 ||
      typeof claims.attemptId !== "string" ||
      typeof claims.integrationId !== "string" ||
      typeof claims.credentialSlot !== "string" ||
      typeof claims.reference !== "string" ||
      claims.reference !== webhookReference(claims.attemptId)
    ) {
      throw new InternalOimWorkerRouteError(400, "oim_webhook_use_token_invalid");
    }
    return claims as WebhookUseClaims;
  }

  private webhookResult(
    pkg: ActiveOimPackage,
    operationId: string,
    subscriptionId: string,
    identity: Awaited<ReturnType<InternalOimWorkerHost["verifiedIdentity"]>>,
    response: unknown,
    expiresAt: string | undefined
  ) {
    return {
      subscriptionId,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      verifiedIdentity: {
        externalTenantId: identity.externalTenantId,
        externalAccountId: identity.externalAccountId,
        proofDigest: canonicalHash({
          kind: "oim_authenticated_webhook_registration",
          version: 1,
          manifestDigest: canonicalHash(pkg.manifest),
          operationId,
          subscriptionId,
          connectionIdentityProofDigest: identity.proofDigest,
          response,
        }),
        verifiedAt: this.now().toISOString(),
        verifiedBy: "oim-worker-host:webhook-registration",
      },
    };
  }
}
