import {
  type AuthEndpoints,
  type ConnectionCredentialVault,
  connectionMatchesPackage,
  createOimConnection,
  type OimOAuthRefresh,
  type OimOAuthRefreshRequest,
  type OimPackageCatalogEntry,
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
  PublishConnectionAuthStep,
} from "@tulipfarm/storage";
import { ConnectionExternalIdentityConflictError } from "@tulipfarm/storage";
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
  readonly identity: VerifiedConnectionIdentityEvidence;
  readonly credentialValues: Readonly<Record<string, string>>;
  readonly configuration: Readonly<Record<string, string>>;
  readonly expiresAt: string | null;
}

export interface OimConnectionServiceDeps {
  readonly businessId: string;
  readonly catalog: readonly OimPackageCatalogEntry[];
  readonly connections: ConnectionRepository;
  readonly authSteps: AuthStepRepository;
  readonly credentials: ConnectionCredentialVault;
  readonly authRequests: OimAuthRequestRepository;
  readonly endpoints: AuthEndpoints;
  readonly refreshOAuth: (request: OimOAuthRefreshRequest) => Promise<OimOAuthRefresh>;
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

export class OimConnectionRequestError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 409 | 502,
    readonly code: string
  ) {
    super(code);
  }
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

  async list(key: string, actor: ConnectionActor): Promise<readonly PersistedConnection[]> {
    const pkg = this.package(key);
    const rows = await this.deps.connections.listForIntegration(this.deps.businessId, pkg.identity);
    return rows.filter(
      (connection) =>
        connection.businessId === this.deps.businessId &&
        connectionMatchesPackage(connection, pkg) &&
        mayAccess(connection, actor)
    );
  }

  async get(
    key: string,
    connectionId: string,
    actor: ConnectionActor
  ): Promise<PersistedConnection> {
    return (await this.connection(key, connectionId, actor)).connection;
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
  ) {
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
    return createOimConnection(
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
  }

  async startAuthorization(
    key: string,
    connectionId: string,
    requestedStepId: string,
    actor: ConnectionActor,
    org?: string
  ): Promise<Awaited<ReturnType<typeof startAuthStep>>> {
    const { pkg, connection } = await this.connection(key, connectionId, actor);
    if (connection.status !== "active") {
      throw new OimConnectionRequestError(409, "connection_inactive");
    }
    const step = browserStep(pkg.manifest, requestedStepId);
    if (step === undefined) throw new OimConnectionRequestError(404, "auth_step_not_found");
    const current = await this.deps.authSteps.find(
      this.deps.businessId,
      connection.id,
      requestedStepId
    );
    if (current === null) throw new OimConnectionRequestError(409, "auth_step_not_initialized");
    const now = (this.deps.now ?? (() => new Date()))().toISOString();
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
    if (stepIndex === undefined) throw new OimConnectionRequestError(404, "auth_step_not_found");

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
    await this.applyAuthorization(
      validated.manifest,
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
    if (connection.status !== "active") {
      throw new OimConnectionRequestError(409, "connection_inactive");
    }
    try {
      return await refreshOimConnection(
        {
          authSteps: this.deps.authSteps,
          connections: this.deps.connections,
          credentials: this.deps.credentials,
          refreshOAuth: this.deps.refreshOAuth,
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

  async revoke(key: string, connectionId: string, actor: ConnectionActor): Promise<void> {
    const { connection } = await this.connection(key, connectionId, actor);
    await this.revokeConnection(connection);
  }

  async revokeById(connectionId: string, actor: ConnectionActor): Promise<void> {
    const connection = await this.deps.connections.findById(this.deps.businessId, connectionId);
    if (
      connection === null ||
      connection.businessId !== this.deps.businessId ||
      !mayAccess(connection, actor)
    ) {
      throw new OimConnectionRequestError(404, "connection_not_found");
    }
    await this.revokeConnection(connection);
  }

  private async revokeConnection(connection: PersistedConnection): Promise<void> {
    await revokeOimConnection(
      {
        connections: this.deps.connections,
        credentials: this.deps.credentials,
      },
      connection
    );
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

  private async applyAuthorization(
    manifest: OimManifest,
    connection: PersistedConnection,
    authStep: ConnectionAuthStep,
    patch: {
      readonly slots: Readonly<Record<string, string>>;
      readonly configuration: Readonly<Record<string, string>>;
      readonly expiresAt: string | null;
    },
    verifiedIdentity: VerifiedConnectionIdentityEvidence
  ): Promise<void> {
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
        externalIdentity: {
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
        verifiedIdentity: {
          businessId: this.deps.businessId,
          connectionId: connection.id,
          integrationId: connection.integration.id,
          integrationMajorVersion: connection.integration.majorVersion,
          ...verifiedIdentity,
          proofKind: "auth",
        },
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
