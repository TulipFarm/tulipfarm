import {
  type AuthEndpoints,
  type ConnectionCredentialVault,
  connectionMatchesPackage,
  createOimConnection,
  type IngressTeardownResult,
  OimAuthVerificationError,
  type OimConnectionVerificationEvidence,
  type OimOAuthRefresh,
  type OimOAuthRefreshRequest,
  type OimPackageCatalogEntry,
  type OimReleasePackage,
  OimWebhookRegistrationError,
  planWebhookRegistration,
  projectVerifiedConnectionIdentity,
  type ResolvedOimPackage,
  refreshOimConnection,
  resolveOimPackage,
  revokeOimConnection,
  type VerifiedConnectionIdentityEvidence,
} from "@tulipfarm/integrations";
import { canonicalHash, type OimConnection, type OimManifest } from "@tulipfarm/schema";
import type {
  ConnectionAuthStep,
  ConnectionAuthStepFence,
  IntegrationAuthRequestDoc,
  PersistedConnection,
  PersistedWebhookRegistration,
  PublishConnectionAuthStep,
  WebhookRegistrationKey,
  WebhookRegistrationTarget,
} from "@tulipfarm/storage";
import { ConnectionExternalIdentityConflictError } from "@tulipfarm/storage";
import { captureOimWebhookCleanupPackage } from "../../internal/oim-webhook-cleanup-package";
import {
  AuthBrokerError,
  completeAuthStep,
  type IntegrationAuthRequestRepo,
  startAuthStep,
} from "../auth-broker";
import {
  oimAuthLegacyManifest,
  oimConfigurationEnv,
  oimConnectionPatchFromEnv,
  oimLegacyStepIndex,
  oimSlotEnv,
} from "../oim-oauth";

type Owner = OimConnection["owner"];

interface ConnectionRepository {
  put(businessId: string, connection: OimConnection): Promise<void>;
  findById(businessId: string, id: string): Promise<PersistedConnection | null>;
  listForIntegration(
    businessId: string,
    integration: OimConnection["integration"]
  ): Promise<readonly PersistedConnection[]>;
  claimAuthStep(input: ConnectionAuthStepFence): Promise<boolean>;
  publishAuthStep(input: PublishConnectionAuthStep): Promise<boolean>;
  markActionRequired(
    businessId: string,
    connectionId: string,
    integration: OimConnection["integration"],
    owner: OimConnection["owner"],
    checkedAt: string
  ): Promise<boolean>;
  fenceRevocation(businessId: string, connectionId: string): Promise<PersistedConnection | null>;
}

interface AuthStepRepository {
  initialize(
    input: Omit<ConnectionAuthStep, "revision" | "createdAt" | "updatedAt">
  ): Promise<ConnectionAuthStep>;
  put(
    input: Omit<ConnectionAuthStep, "revision" | "createdAt" | "updatedAt">
  ): Promise<ConnectionAuthStep>;
  find(
    businessId: string,
    connectionId: string,
    stepId: string
  ): Promise<ConnectionAuthStep | null>;
  list(businessId: string, connectionId: string): Promise<readonly ConnectionAuthStep[]>;
}

type OimAuthRequestRepository = IntegrationAuthRequestRepo & {
  findActive(state: string): Promise<IntegrationAuthRequestDoc | null>;
};

export interface VerifiedOimAuthorization {
  readonly identity?: VerifiedConnectionIdentityEvidence;
  readonly credentialValues: Readonly<Record<string, string>>;
  readonly configuration: Readonly<Record<string, string>>;
  readonly expiresAt: string | null;
}

export interface OimConnectionServiceDeps {
  readonly businessId: string;
  readonly catalog: readonly OimPackageCatalogEntry[];
  readonly registrationPackages?: {
    packageFor(integrationKey: string): Promise<OimReleasePackage | null>;
  };
  readonly connections: ConnectionRepository;
  readonly authSteps: AuthStepRepository;
  readonly credentials: ConnectionCredentialVault;
  readonly authRequests: OimAuthRequestRepository;
  readonly endpoints: AuthEndpoints;
  readonly ingress: {
    isDisabled(businessId: string, connectionId: string): Promise<boolean>;
    requestWebhookRegistration(
      key: WebhookRegistrationKey,
      target: WebhookRegistrationTarget,
      now?: Date
    ): Promise<PersistedWebhookRegistration>;
    teardown(key: WebhookRegistrationKey, now?: Date): Promise<IngressTeardownResult>;
  };
  readonly refreshOAuth: (request: OimOAuthRefreshRequest) => Promise<OimOAuthRefresh>;
  readonly verification?: {
    verify(input: {
      readonly package: ResolvedOimPackage;
      readonly connection: PersistedConnection;
    }): Promise<OimConnectionVerificationEvidence>;
    verifyCandidate(input: {
      readonly package: ResolvedOimPackage;
      readonly connection: PersistedConnection;
      readonly authSteps: readonly ConnectionAuthStep[];
      readonly credentialValues: Readonly<Record<string, string>>;
    }): Promise<OimConnectionVerificationEvidence>;
    publish(
      evidence: OimConnectionVerificationEvidence,
      identity?: VerifiedConnectionIdentityEvidence
    ): Promise<void>;
  };
  /**
   * Resolves browser callback candidates to provider-verified values and identity server-side.
   * The returned values, not the browser candidates, are published to the Connection.
   */
  readonly verifyAuthorization: (request: {
    readonly manifest: OimManifest;
    readonly stepId: string;
    readonly connection: PersistedConnection;
    readonly callbackQuery: Readonly<Record<string, string>>;
    readonly candidateCredentialValues: Readonly<Record<string, string>>;
    readonly candidateConfiguration: Readonly<Record<string, string>>;
    readonly candidateExpiresAt: string | null;
  }) => Promise<VerifiedOimAuthorization | null>;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

export interface ConnectionActor {
  readonly principalId: string;
  readonly mayManageShared: boolean;
}

export interface OimConnectionSetup {
  readonly integration: OimConnection["integration"];
  readonly connectionHealth?: OimConnection["health"]["status"];
  readonly allowedOwnerScopes: readonly Owner["scope"][];
  readonly configurationFields: readonly {
    readonly id: string;
    readonly label: string;
    readonly type: "string" | "url" | "boolean" | "integer";
    readonly required: boolean;
    readonly agentVisible: boolean;
  }[];
  readonly fieldSteps: readonly {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly fields: readonly {
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly input: "text" | "password" | "url";
      readonly required: boolean;
      readonly secret: boolean;
    }[];
  }[];
  readonly initialAuthorizationSteps: readonly {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly type: "oauth2" | "app_manifest" | "install" | "webhook";
  }[];
  readonly pendingAuthorizationStepIds?: readonly string[];
}

export class OimConnectionRequestError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 409 | 502,
    readonly code: string
  ) {
    super(code);
  }
}

export interface OimConnectionCreateResult {
  readonly connectionId: string;
  readonly verification:
    | { readonly status: "not_required" | "pending" | "verified" }
    | {
        readonly status: "action_required";
        readonly error:
          | "provider_proof_failed"
          | "verification_unavailable"
          | "verification_persistence_failed";
      };
}

function mayAccess(connection: PersistedConnection, actor: ConnectionActor): boolean {
  return connection.owner.scope === "personal"
    ? connection.owner.principalId === actor.principalId
    : actor.mayManageShared;
}

function browserStep(manifest: OimManifest, stepId: string) {
  return manifest.auth?.steps.find((step) => step.id === stepId && step.type !== "fields");
}

function stepDigest(
  step: NonNullable<ReturnType<typeof browserStep>>,
  revision: number,
  connection: PersistedConnection
): string {
  return canonicalHash({
    step,
    revision,
    businessId: connection.businessId,
    connectionId: connection.id,
    integration: connection.integration,
    owner: connection.owner,
  });
}

export class OimConnectionService {
  constructor(private readonly deps: OimConnectionServiceDeps) {}

  authorizationWebUrl(): string {
    return this.deps.endpoints.webUrl;
  }

  async hasPendingAuthorization(state: string): Promise<boolean> {
    const request = await this.deps.authRequests.findActive(state);
    return request?.connectionId != null;
  }

  async authorizationContext(
    state: string
  ): Promise<{ readonly key: string; readonly connectionId: string } | null> {
    const request = await this.deps.authRequests.findActive(state);
    if (
      request?.connectionId == null ||
      request.oimStepId == null ||
      request.oimStepDigest == null ||
      request.manifestDigest == null ||
      request.packageDigest == null
    ) {
      return null;
    }
    const pkg = resolveOimPackage(this.deps.catalog, request.integrationSlug);
    const connection = await this.deps.connections.findById(
      this.deps.businessId,
      request.connectionId
    );
    const authStep = await this.deps.authSteps.find(
      this.deps.businessId,
      request.connectionId,
      request.oimStepId
    );
    const step = pkg === undefined ? undefined : browserStep(pkg.manifest, request.oimStepId);
    if (
      pkg === undefined ||
      connection === null ||
      authStep === null ||
      step === undefined ||
      connection.status !== "active" ||
      (await this.deps.ingress.isDisabled(this.deps.businessId, connection.id)) ||
      authStep.status !== "pending" ||
      !connectionMatchesPackage(connection, pkg) ||
      request.manifestDigest !== canonicalHash(pkg.manifest) ||
      request.packageDigest !== pkg.packageDigest ||
      request.oimStepDigest !== stepDigest(step, authStep.revision, connection) ||
      (connection.owner.scope === "personal" &&
        (request.principal?.kind !== "user" ||
          request.principal.id !== connection.owner.principalId))
    ) {
      return null;
    }
    return { key: request.integrationSlug, connectionId: request.connectionId };
  }

  private package(key: string) {
    const resolved = resolveOimPackage(this.deps.catalog, key);
    if (resolved === undefined) throw new OimConnectionRequestError(404, "integration_not_found");
    return resolved;
  }

  private async connection(key: string, connectionId: string, actor: ConnectionActor) {
    const pkg = this.package(key);
    const connection = await this.deps.connections.findById(this.deps.businessId, connectionId);
    if (
      connection === null ||
      connection.businessId !== this.deps.businessId ||
      !connectionMatchesPackage(connection, pkg) ||
      !mayAccess(connection, actor)
    ) {
      throw new OimConnectionRequestError(404, "connection_not_found");
    }
    return { pkg, connection };
  }

  private async requireOperational(connection: PersistedConnection): Promise<void> {
    if (connection.status !== "active") {
      throw new OimConnectionRequestError(409, "connection_inactive");
    }
    if (await this.deps.ingress.isDisabled(this.deps.businessId, connection.id)) {
      throw new OimConnectionRequestError(409, "connection_disconnecting");
    }
  }

  async list(key: string, actor: ConnectionActor): Promise<readonly PersistedConnection[]> {
    const pkg = this.package(key);
    const rows = await this.deps.connections.listForIntegration(this.deps.businessId, pkg.identity);
    return rows.filter(
      (connection) =>
        connection.businessId === this.deps.businessId &&
        connection.status === "active" &&
        connectionMatchesPackage(connection, pkg) &&
        mayAccess(connection, actor)
    );
  }

  async setup(
    key: string,
    actor: ConnectionActor,
    connectionId?: string
  ): Promise<OimConnectionSetup> {
    const pkg = this.package(key);
    const auth = pkg.manifest.auth;
    let pendingAuthorizationStepIds: readonly string[] | undefined;
    let connectionHealth: OimConnection["health"]["status"] | undefined;
    if (connectionId !== undefined) {
      const { connection } = await this.connection(key, connectionId, actor);
      connectionHealth = connection.health.status;
      const rows = await this.deps.authSteps.list(this.deps.businessId, connection.id);
      const pending = new Set(
        rows.filter((row) => row.status === "pending").map((row) => row.stepId)
      );
      pendingAuthorizationStepIds = (auth?.steps ?? [])
        .filter((step) => step.type !== "fields" && pending.has(step.id))
        .map((step) => step.id);
    }
    return {
      integration: pkg.identity,
      ...(connectionHealth === undefined ? {} : { connectionHealth }),
      allowedOwnerScopes: actor.mayManageShared
        ? ["personal", "team", "organization"]
        : ["personal"],
      configurationFields: (auth?.configurationFields ?? []).map((field) => ({
        id: field.id,
        label: field.label,
        type: field.type,
        required: field.required === true,
        agentVisible: field.agentVisible === true,
      })),
      fieldSteps: (auth?.steps ?? [])
        .filter((step) => step.type === "fields")
        .map((step) => ({
          id: step.id,
          title: step.title,
          ...(step.description === undefined ? {} : { description: step.description }),
          fields: step.fields.map((field) => ({
            id: field.id,
            label: field.label,
            ...(field.description === undefined ? {} : { description: field.description }),
            input: field.input,
            required: field.required === true,
            secret: field.target.type === "credential",
          })),
        })),
      initialAuthorizationSteps: (auth?.steps ?? [])
        .filter((step) => step.type !== "fields")
        .map((step) => ({
          id: step.id,
          title: step.title,
          ...(step.description === undefined ? {} : { description: step.description }),
          type: step.type,
        })),
      ...(pendingAuthorizationStepIds === undefined ? {} : { pendingAuthorizationStepIds }),
    };
  }

  async get(
    key: string,
    connectionId: string,
    actor: ConnectionActor
  ): Promise<PersistedConnection> {
    return (await this.connection(key, connectionId, actor)).connection;
  }

  isDisconnecting(connectionId: string): Promise<boolean> {
    return this.deps.ingress.isDisabled(this.deps.businessId, connectionId);
  }

  async create(
    key: string,
    actor: ConnectionActor,
    input: {
      readonly label: string;
      readonly owner: Owner;
      readonly values: Readonly<Record<string, string>>;
      readonly isDefault?: boolean;
    }
  ): Promise<OimConnectionCreateResult> {
    const pkg = this.package(key);
    if (
      (input.owner.scope === "personal" && input.owner.principalId !== actor.principalId) ||
      (input.owner.scope !== "personal" && !actor.mayManageShared)
    ) {
      throw new OimConnectionRequestError(403, "forbidden");
    }
    const missingField = (pkg.manifest.auth?.steps ?? [])
      .filter((step) => step.type === "fields")
      .flatMap((step) => step.fields)
      .find((field) => field.required === true && !input.values[field.id]);
    if (missingField !== undefined) {
      throw new OimConnectionRequestError(400, `missing_field:${missingField.id}`);
    }
    const created = await createOimConnection(
      {
        connections: this.deps.connections,
        authSteps: this.deps.authSteps,
        credentials: this.deps.credentials,
        now: this.deps.now,
      },
      {
        businessId: this.deps.businessId,
        manifest: pkg.manifest,
        label: input.label,
        owner: input.owner,
        values: input.values,
        isDefault: input.isDefault,
      }
    );
    if (pkg.manifest.auth?.verification === undefined) {
      return { ...created, verification: { status: "not_required" } };
    }
    return {
      ...created,
      verification: await this.verifyFieldConnection(pkg, created.connectionId),
    };
  }

  async startAuthorization(
    key: string,
    connectionId: string,
    requestedStepId: string,
    actor: ConnectionActor,
    org?: string
  ): Promise<Awaited<ReturnType<typeof startAuthStep>> | { readonly action: "pending" }> {
    const { pkg, connection } = await this.connection(key, connectionId, actor);
    await this.requireOperational(connection);
    const step = browserStep(pkg.manifest, requestedStepId);
    if (step === undefined) throw new OimConnectionRequestError(404, "auth_step_not_found");
    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    const existing = await this.deps.authSteps.find(
      this.deps.businessId,
      connection.id,
      requestedStepId
    );
    const current =
      existing ??
      (await this.deps.authSteps.initialize({
        businessId: this.deps.businessId,
        connectionId: connection.id,
        stepId: requestedStepId,
        status: "pending",
        accessSlot: null,
        accessSecretRef: null,
        refreshSlot: null,
        refreshSecretRef: null,
        externalIdentity: null,
        expiresAt: null,
        healthCheckedAt: now,
      }));
    if (step.type === "webhook") {
      const registrationPackage = await this.deps.registrationPackages?.packageFor(key);
      if (
        registrationPackage === undefined ||
        registrationPackage === null ||
        canonicalHash(registrationPackage.manifest) !== canonicalHash(pkg.manifest)
      ) {
        throw new OimConnectionRequestError(409, "registration_package_unavailable");
      }
      const plan = planWebhookRegistration({
        businessId: this.deps.businessId,
        integrationKey: key,
        connectionId: connection.id,
        manifest: pkg.manifest,
        packageSnapshot: captureOimWebhookCleanupPackage(registrationPackage),
        publicApiUrl: this.deps.endpoints.apiUrl,
      });
      if (plan.target.stepId !== step.id) {
        throw new OimConnectionRequestError(404, "auth_step_not_found");
      }
      const registration = await this.deps.ingress.requestWebhookRegistration(
        plan.key,
        plan.target,
        new Date(now)
      );
      return registration.state === "active"
        ? { action: "completed", env: {} }
        : { action: "pending" };
    }

    const claimed = await this.deps.connections.claimAuthStep({
      businessId: this.deps.businessId,
      connectionId: connection.id,
      integration: connection.integration,
      owner: connection.owner,
      stepId: current.stepId,
      healthCheckedAt: now,
      expectedRevision: current.revision,
    });
    if (!claimed) throw new OimConnectionRequestError(409, "auth_step_conflict");

    const translated = oimAuthLegacyManifest(pkg.manifest, {
      personal: connection.owner.scope === "personal",
    });
    const stepIndex = oimLegacyStepIndex(translated, step.id);
    if (stepIndex < 0) throw new OimConnectionRequestError(404, "auth_step_not_found");

    return startAuthStep({
      slug: key,
      manifest: translated,
      stepIndex,
      env: await this.readCredentialEnv(connection),
      endpoints: this.deps.endpoints,
      repo: this.deps.authRequests,
      connectionId: connection.id,
      principal: { kind: "user", id: actor.principalId },
      ...(org === undefined ? {} : { org }),
      oim: {
        stepId: step.id,
        stepDigest: stepDigest(step, current.revision + 1, connection),
        manifestDigest: canonicalHash(pkg.manifest),
        packageDigest: pkg.packageDigest,
      },
      fetchImpl: this.deps.fetchImpl,
    });
  }

  async completeAuthorization(query: Record<string, string>): Promise<{
    readonly key: string;
    readonly connectionId: string;
  }> {
    let validated:
      | {
          request: IntegrationAuthRequestDoc;
          manifest: OimManifest;
          connection: PersistedConnection;
          authStep: ConnectionAuthStep;
        }
      | undefined;
    const completed = await completeAuthStep({
      query,
      endpoints: this.deps.endpoints,
      repo: this.deps.authRequests,
      fetchImpl: this.deps.fetchImpl,
      loadManifest: (key) => {
        const pkg = resolveOimPackage(this.deps.catalog, key);
        return pkg === undefined ? undefined : oimAuthLegacyManifest(pkg.manifest);
      },
      loadEnv: async (key, connectionId) => {
        const pkg = this.package(key);
        if (connectionId === null || connectionId === undefined) return {};
        const connection = await this.deps.connections.findById(this.deps.businessId, connectionId);
        if (
          connection === null ||
          connection.businessId !== this.deps.businessId ||
          !connectionMatchesPackage(connection, pkg)
        ) {
          return {};
        }
        return this.readCredentialEnv(connection);
      },
      validateRequest: async (request) => {
        if (
          !request.connectionId ||
          !request.oimStepId ||
          !request.oimStepDigest ||
          !request.manifestDigest ||
          !request.packageDigest
        ) {
          throw new AuthBrokerError("invalid_state", "incomplete Connection authorization state");
        }
        const pkg = resolveOimPackage(this.deps.catalog, request.integrationSlug);
        const connection = await this.deps.connections.findById(
          this.deps.businessId,
          request.connectionId
        );
        const authStep = await this.deps.authSteps.find(
          this.deps.businessId,
          request.connectionId,
          request.oimStepId
        );
        const step = pkg === undefined ? undefined : browserStep(pkg.manifest, request.oimStepId);
        if (
          pkg === undefined ||
          connection === null ||
          connection.businessId !== this.deps.businessId ||
          authStep === null ||
          step === undefined ||
          connection.status !== "active" ||
          (await this.deps.ingress.isDisabled(this.deps.businessId, connection.id)) ||
          authStep.status !== "pending" ||
          !connectionMatchesPackage(connection, pkg) ||
          request.manifestDigest !== canonicalHash(pkg.manifest) ||
          request.packageDigest !== pkg.packageDigest ||
          request.oimStepDigest !== stepDigest(step, authStep.revision, connection)
        ) {
          throw new AuthBrokerError("invalid_state", "Connection authorization state changed");
        }
        if (
          connection.owner.scope === "personal" &&
          (request.principal?.kind !== "user" ||
            request.principal.id !== connection.owner.principalId)
        ) {
          throw new AuthBrokerError("invalid_state", "Connection authorization owner changed");
        }
        validated = { request, manifest: pkg.manifest, connection, authStep };
      },
    });
    if (validated === undefined) throw new AuthBrokerError("invalid_state", "state not validated");

    const patch = oimConnectionPatchFromEnv(validated.manifest, completed.env);
    const verified = await this.deps.verifyAuthorization({
      manifest: validated.manifest,
      stepId: validated.authStep.stepId,
      connection: validated.connection,
      callbackQuery: query,
      candidateCredentialValues: patch.slots,
      candidateConfiguration: patch.configuration,
      candidateExpiresAt: patch.expiresAt,
    });
    if (verified === null) {
      throw new AuthBrokerError("invalid_state", "provider authorization could not be verified");
    }
    const pkg = this.package(validated.request.integrationSlug);
    if (pkg.manifest.auth?.verification === undefined && verified.identity === undefined) {
      throw new AuthBrokerError("invalid_state", "provider identity could not be verified");
    }
    await this.applyAuthorization(
      pkg,
      validated.connection,
      validated.authStep,
      {
        slots: verified.credentialValues,
        configuration: verified.configuration,
        expiresAt: verified.expiresAt,
      },
      verified.identity
    );
    return {
      key: validated.request.integrationSlug,
      connectionId: validated.connection.id,
    };
  }

  async refresh(key: string, connectionId: string, actor: ConnectionActor) {
    const { pkg, connection } = await this.connection(key, connectionId, actor);
    await this.requireOperational(connection);
    if (
      pkg.manifest.auth?.verification !== undefined &&
      !(pkg.manifest.auth.steps ?? []).some((step) => step.type === "oauth2")
    ) {
      const verification = await this.verifyFieldConnection(pkg, connection.id);
      return {
        connectionId: connection.id,
        health:
          verification.status === "verified" ? ("healthy" as const) : ("action_required" as const),
        steps:
          verification.status === "action_required"
            ? [
                {
                  stepId: "verification",
                  status: "action_required" as const,
                  error: verification.error,
                },
              ]
            : [],
      };
    }
    const verification = this.deps.verification;
    try {
      return await refreshOimConnection(
        {
          authSteps: this.deps.authSteps,
          connections: this.deps.connections,
          credentials: this.deps.credentials,
          refreshOAuth: this.deps.refreshOAuth,
          packageDigest: pkg.packageDigest,
          ...(verification === undefined
            ? {}
            : {
                verifyConnectionCandidate: (input) =>
                  verification.verifyCandidate({
                    package: pkg,
                    connection: input.connection,
                    authSteps: input.authSteps,
                    credentialValues: input.credentialValues,
                  }),
              }),
          now: this.deps.now,
        },
        pkg.manifest,
        connection
      );
    } catch (error) {
      if (error instanceof ConnectionExternalIdentityConflictError) {
        throw new OimConnectionRequestError(409, "external_identity_conflict");
      }
      throw error;
    }
  }

  async revoke(
    key: string,
    connectionId: string,
    actor: ConnectionActor
  ): Promise<{ readonly status: "revoked" | "disconnect_pending" }> {
    const { connection } = await this.connection(key, connectionId, actor);
    return this.revokeConnection(connection);
  }

  async revokeById(
    connectionId: string,
    actor: ConnectionActor
  ): Promise<{ readonly status: "revoked" | "disconnect_pending" }> {
    const connection = await this.deps.connections.findById(this.deps.businessId, connectionId);
    if (
      connection === null ||
      connection.businessId !== this.deps.businessId ||
      !mayAccess(connection, actor)
    ) {
      throw new OimConnectionRequestError(404, "connection_not_found");
    }
    return this.revokeConnection(connection);
  }

  private async revokeConnection(
    connection: PersistedConnection
  ): Promise<{ readonly status: "revoked" | "disconnect_pending" }> {
    let teardown: IngressTeardownResult;
    try {
      teardown = await this.deps.ingress.teardown({
        businessId: this.deps.businessId,
        connectionId: connection.id,
        integrationId: connection.integration.id,
        integrationMajorVersion: connection.integration.majorVersion,
      });
    } catch (error) {
      if (error instanceof OimWebhookRegistrationError && error.code === "cleanup_failed") {
        throw new OimConnectionRequestError(409, "disconnect_cleanup_failed");
      }
      throw error;
    }
    if (!teardown.remoteCleanupComplete) return { status: "disconnect_pending" };
    await revokeOimConnection(
      {
        connections: this.deps.connections,
        credentials: this.deps.credentials,
      },
      connection
    );
    return { status: "revoked" };
  }

  private async readCredentialEnv(
    connection: PersistedConnection
  ): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const [field, value] of Object.entries(connection.configuration)) {
      env[oimConfigurationEnv(field)] = String(value);
    }
    for (const [slot, reference] of Object.entries(connection.secretBindings)) {
      env[oimSlotEnv(slot)] = await this.deps.credentials.read(reference);
    }
    return env;
  }

  private async verifyFieldConnection(
    pkg: ResolvedOimPackage,
    connectionId: string
  ): Promise<OimConnectionCreateResult["verification"]> {
    const verification = this.deps.verification;
    if (verification === undefined) {
      return { status: "action_required", error: "verification_unavailable" };
    }
    let connection: PersistedConnection | null;
    let rows: readonly ConnectionAuthStep[];
    try {
      connection = await this.deps.connections.findById(this.deps.businessId, connectionId);
      if (connection === null) {
        return { status: "action_required", error: "verification_persistence_failed" };
      }
      rows = await this.deps.authSteps.list(this.deps.businessId, connection.id);
    } catch {
      return { status: "action_required", error: "verification_persistence_failed" };
    }
    if (!rows.every((row) => row.status === "active")) return { status: "pending" };
    const publicationRow = rows[0];
    if (publicationRow === undefined) {
      return { status: "action_required", error: "verification_persistence_failed" };
    }

    let evidence: OimConnectionVerificationEvidence;
    try {
      evidence = await verification.verify({ package: pkg, connection });
    } catch (error) {
      return {
        status: "action_required",
        error:
          error instanceof OimAuthVerificationError
            ? "provider_proof_failed"
            : "verification_unavailable",
      };
    }

    const identity = projectVerifiedConnectionIdentity(evidence) ?? undefined;
    try {
      const published = await this.deps.connections.publishAuthStep({
        businessId: connection.businessId,
        connectionId: connection.id,
        integration: connection.integration,
        owner: connection.owner,
        stepId: publicationRow.stepId,
        expectedRevision: publicationRow.revision,
        status: "active",
        accessSlot: publicationRow.accessSlot,
        accessSecretRef: publicationRow.accessSecretRef,
        refreshSlot: publicationRow.refreshSlot,
        refreshSecretRef: publicationRow.refreshSecretRef,
        externalIdentity: publicationRow.externalIdentity,
        expiresAt: publicationRow.expiresAt,
        healthCheckedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
        configuration: {},
        secretBindings: {},
        ...(identity === undefined
          ? {}
          : {
              verifiedIdentity: {
                businessId: connection.businessId,
                connectionId: connection.id,
                integrationId: connection.integration.id,
                integrationMajorVersion: connection.integration.majorVersion,
                ...identity,
                proofKind: "health" as const,
              },
            }),
        verificationEvidence: evidence,
      });
      return published
        ? { status: "verified" }
        : { status: "action_required", error: "verification_persistence_failed" };
    } catch {
      return { status: "action_required", error: "verification_persistence_failed" };
    }
  }

  private async applyAuthorization(
    pkg: ResolvedOimPackage,
    connection: PersistedConnection,
    authStep: ConnectionAuthStep,
    patch: {
      readonly slots: Readonly<Record<string, string>>;
      readonly configuration: Readonly<Record<string, string>>;
      readonly expiresAt: string | null;
    },
    legacyVerifiedIdentity: VerifiedConnectionIdentityEvidence | undefined
  ): Promise<void> {
    const { manifest } = pkg;
    const step = browserStep(manifest, authStep.stepId);
    const stepBindings = step !== undefined && "bindings" in step ? step.bindings : [];
    const stepSlots = new Set(
      stepBindings.flatMap((binding) =>
        binding.target.type === "credential" ? [binding.target.slot] : []
      )
    );
    const stepConfiguration = new Set(
      stepBindings.flatMap((binding) =>
        binding.target.type === "configuration" ? [binding.target.field] : []
      )
    );
    const staged: `secret://${string}`[] = [];
    const replaced: string[] = [];
    const bindingPatch: Record<string, `secret://${string}`> = {};
    try {
      for (const [slot, plaintext] of Object.entries(patch.slots)) {
        if (!stepSlots.has(slot)) continue;
        const reference = connection.secretBindings[slot];
        if (reference === undefined) {
          const stagedReference = await this.deps.credentials.create(
            manifest.metadata.id,
            slot,
            plaintext
          );
          staged.push(stagedReference);
          bindingPatch[slot] = stagedReference;
          continue;
        }
        if ((await this.deps.credentials.read(reference)) === plaintext) continue;
        const stagedReference = await this.deps.credentials.create(
          manifest.metadata.id,
          slot,
          plaintext
        );
        staged.push(stagedReference);
        bindingPatch[slot] = stagedReference;
        replaced.push(reference);
      }
    } catch (error) {
      await this.deps.credentials.revokeReferences(staged);
      throw error;
    }
    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    const slotKinds = new Map(
      (manifest.auth?.credentialSlots ?? []).map((slot) => [slot.id, slot.kind])
    );
    const accessSlot = [...stepSlots].find((slot) => slotKinds.get(slot) === "oauth2_access_token");
    const refreshSlot = [...stepSlots].find(
      (slot) => slotKinds.get(slot) === "oauth2_refresh_token"
    );
    const configuration = Object.fromEntries(
      Object.entries(patch.configuration).filter(([field]) => stepConfiguration.has(field))
    );

    try {
      let verificationEvidence: OimConnectionVerificationEvidence | undefined;
      let verifiedIdentity = legacyVerifiedIdentity;
      if (manifest.auth?.verification !== undefined) {
        if (this.deps.verification === undefined) {
          throw new Error("oim_verification_host_not_configured");
        }
        const proposedConnection: PersistedConnection = {
          ...connection,
          configuration: { ...connection.configuration, ...configuration },
          secretBindings: { ...connection.secretBindings, ...bindingPatch },
        };
        const proposedSteps = (
          await this.deps.authSteps.list(this.deps.businessId, connection.id)
        ).map((row) =>
          row.stepId === authStep.stepId
            ? {
                ...row,
                status: "active" as const,
                revision: row.revision + 1,
                accessSlot: accessSlot ?? null,
                accessSecretRef:
                  accessSlot === undefined
                    ? null
                    : (bindingPatch[accessSlot] ?? connection.secretBindings[accessSlot] ?? null),
                refreshSlot: refreshSlot ?? null,
                refreshSecretRef:
                  refreshSlot === undefined
                    ? null
                    : (bindingPatch[refreshSlot] ?? connection.secretBindings[refreshSlot] ?? null),
              }
            : row
        );
        const credentialValues: Record<string, string> = {};
        for (const [slot, reference] of Object.entries(proposedConnection.secretBindings)) {
          credentialValues[slot] =
            patch.slots[slot] ?? (await this.deps.credentials.read(reference));
        }
        verificationEvidence = await this.deps.verification.verifyCandidate({
          package: pkg,
          connection: proposedConnection,
          authSteps: proposedSteps,
          credentialValues,
        });
        verifiedIdentity = projectVerifiedConnectionIdentity(verificationEvidence) ?? undefined;
      }
      const published = await this.deps.connections.publishAuthStep({
        businessId: this.deps.businessId,
        connectionId: connection.id,
        integration: connection.integration,
        owner: connection.owner,
        stepId: authStep.stepId,
        expectedRevision: authStep.revision,
        status: "active",
        accessSlot: accessSlot ?? null,
        accessSecretRef:
          accessSlot === undefined
            ? null
            : (bindingPatch[accessSlot] ?? connection.secretBindings[accessSlot] ?? null),
        refreshSlot: refreshSlot ?? null,
        refreshSecretRef:
          refreshSlot === undefined
            ? null
            : (bindingPatch[refreshSlot] ?? connection.secretBindings[refreshSlot] ?? null),
        externalIdentity:
          verifiedIdentity === undefined
            ? null
            : {
                externalTenantId: verifiedIdentity.externalTenantId,
                externalAccountId: verifiedIdentity.externalAccountId,
                proofDigest: verifiedIdentity.proofDigest,
                verifiedAt: verifiedIdentity.verifiedAt,
                verifiedBy: verifiedIdentity.verifiedBy,
              },
        expiresAt: patch.expiresAt,
        healthCheckedAt: now,
        configuration,
        secretBindings: bindingPatch,
        ...(verifiedIdentity === undefined
          ? {}
          : {
              verifiedIdentity: {
                businessId: this.deps.businessId,
                connectionId: connection.id,
                integrationId: connection.integration.id,
                integrationMajorVersion: connection.integration.majorVersion,
                ...verifiedIdentity,
                proofKind: "auth" as const,
              },
            }),
        ...(verificationEvidence === undefined ? {} : { verificationEvidence }),
      });
      if (!published) {
        throw new AuthBrokerError("invalid_state", "Connection authorization state changed");
      }
    } catch (error) {
      await this.deps.credentials.revokeReferences(staged);
      if (error instanceof ConnectionExternalIdentityConflictError) {
        throw new AuthBrokerError("invalid_state", "provider identity does not match Connection");
      }
      throw error;
    }
    await this.deps.credentials.revokeReferences(replaced);
  }
}
