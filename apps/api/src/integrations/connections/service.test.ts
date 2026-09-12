import type { ConnectionCredentialVault, OimPackageCatalogEntry } from "@tulipfarm/integrations";
import type { OimConnection, OimManifest } from "@tulipfarm/schema";
import type {
  ConnectionAuthStep,
  IntegrationAuthRequestDoc,
  IntegrationAuthRequestRepo,
  PersistedConnection,
  UpdateConnectionAuthStep,
  UpdateConnectionAuthStepHealth,
} from "@tulipfarm/storage";
import { ConnectionExternalIdentityConflictError } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { OimConnectionService, type OimConnectionServiceDeps } from "./service";

const NOW = new Date("2026-09-12T12:00:00.000Z");

function manifest(description = "Acme"): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version: "2.0.0",
      description,
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", auth: "1.0" },
    auth: {
      credentialSlots: [
        { id: "app_token", label: "App token", kind: "api_key" },
        { id: "healthy_token", label: "Healthy token", kind: "api_key" },
      ],
      steps: [
        {
          id: "app",
          title: "Create app",
          type: "app_manifest",
          createUrl: "https://provider.test/apps/new",
          manifest: { callback_url: "{callback_url}", state: "{state}" },
          bindings: [{ sourcePath: "/token", target: { type: "credential", slot: "app_token" } }],
        },
      ],
    },
    operations: [
      {
        id: "read",
        name: "Read",
        description: "Read.",
        effect: "read",
        identityMode: "shared_or_personal",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://provider.test",
          path: "/items",
        },
        response: { schema: { type: "object" }, maxBytes: 1_024 },
      },
    ],
  } as OimManifest;
}

function connection(): PersistedConnection {
  return {
    businessId: "business-1",
    id: "connection-1",
    integration: { id: "acme", majorVersion: 2 },
    label: "Acme",
    owner: { scope: "personal", principalKind: "user", principalId: "user-1" },
    status: "active",
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {
      app_token: "secret://00000000-0000-4000-8000-000000000001",
      healthy_token: "secret://00000000-0000-4000-8000-000000000002",
    },
    health: { status: "action_required", checkedAt: NOW.toISOString() },
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

class Requests implements IntegrationAuthRequestRepo {
  readonly rows = new Map<string, IntegrationAuthRequestDoc>();
  async create(request: IntegrationAuthRequestDoc) {
    this.rows.set(request.state, request);
  }
  async findActive(state: string) {
    return this.rows.get(state) ?? null;
  }
  async consume(state: string) {
    const row = this.rows.get(state);
    if (row === undefined || row.consumedAt !== null || row.expiresAt <= NOW) return null;
    const consumed = { ...row, consumedAt: NOW };
    this.rows.set(state, consumed);
    return consumed;
  }
}

class AuthSteps {
  row: ConnectionAuthStep = {
    businessId: "business-1",
    connectionId: "connection-1",
    stepId: "app",
    status: "pending",
    accessSlot: null,
    accessSecretRef: null,
    refreshSlot: null,
    refreshSecretRef: null,
    externalIdentity: null,
    expiresAt: null,
    healthCheckedAt: NOW.toISOString(),
    revision: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
  async put(input: Omit<ConnectionAuthStep, "revision" | "createdAt" | "updatedAt">) {
    this.row = {
      ...input,
      revision: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    return this.row;
  }
  async find() {
    return this.row;
  }
  async list() {
    return [this.row];
  }
  async update(input: UpdateConnectionAuthStep) {
    if (input.expectedRevision !== this.row.revision) return null;
    this.row = {
      ...this.row,
      ...input,
      updatedAt: input.healthCheckedAt ?? NOW.toISOString(),
      revision: this.row.revision + 1,
    };
    return this.row;
  }
  async updateHealth(input: UpdateConnectionAuthStepHealth) {
    if (input.expectedRevision !== this.row.revision) return null;
    this.row = { ...this.row, ...input, revision: this.row.revision + 1 };
    return this.row;
  }
}

describe("OimConnectionService authorization", () => {
  it("persists and renders real state, then rejects a changed reviewed package before effects", async () => {
    let current = connection();
    const catalog: OimPackageCatalogEntry[] = [{ key: "acme-v2", manifest: manifest() }];
    const requests = new Requests();
    const authSteps = new AuthSteps();
    const rotate = vi.fn(async () => {});
    const values = new Map<string, string>([
      ["secret://00000000-0000-4000-8000-000000000001", "old-app"],
      ["secret://00000000-0000-4000-8000-000000000002", "healthy"],
    ]);
    let nextSecret = 3;
    const create = vi.fn(async (_integrationId: string, _slot: string, plaintext: string) => {
      const reference =
        `secret://00000000-0000-4000-8000-${String(nextSecret++).padStart(12, "0")}` as const;
      values.set(reference, plaintext);
      return reference;
    });
    const revokeReferences = vi.fn(async (_references: readonly string[]) => {});
    const credentials: ConnectionCredentialVault = {
      create,
      async read(reference) {
        const value = values.get(reference);
        if (value === undefined) throw new Error("missing credential");
        return value;
      },
      rotate,
      async revokeReferences(references) {
        await revokeReferences(references);
        for (const reference of references) values.delete(reference);
      },
      async revokeConnection(_connectionId, _bindings, persistRevocation) {
        await persistRevocation();
      },
    };
    let boundIdentity: { tenant: string; account: string } | undefined;
    let verifiedIdentity = {
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofDigest: "a".repeat(64),
      verifiedAt: NOW.toISOString(),
      verifiedBy: "provider-profile",
    };
    let verifiedToken = "provider-confirmed-app";
    let verify: OimConnectionServiceDeps["verifyAuthorization"] = async (input) => ({
      identity: verifiedIdentity,
      credentialValues: {
        ...input.candidateCredentialValues,
        app_token: verifiedToken,
      },
      configuration: input.candidateConfiguration,
      expiresAt: input.candidateExpiresAt,
    });
    const service = new OimConnectionService({
      businessId: "business-1",
      catalog,
      connections: {
        async put(_businessId: string, _connection: OimConnection) {},
        async findById() {
          return current;
        },
        async listForIntegration() {
          return [current];
        },
        async claimAuthStep(input) {
          return (
            (await authSteps.updateHealth({
              businessId: input.businessId,
              connectionId: input.connectionId,
              stepId: input.stepId,
              expectedRevision: input.expectedRevision,
              status: "pending",
              expiresAt: authSteps.row.expiresAt,
              healthCheckedAt: input.healthCheckedAt,
            })) !== null
          );
        },
        async publishAuthStep(input) {
          if (input.verifiedIdentity !== undefined) {
            const next = {
              tenant: input.verifiedIdentity.externalTenantId,
              account: input.verifiedIdentity.externalAccountId,
            };
            if (
              boundIdentity !== undefined &&
              (boundIdentity.tenant !== next.tenant || boundIdentity.account !== next.account)
            ) {
              throw new ConnectionExternalIdentityConflictError(input.connectionId);
            }
            boundIdentity = next;
          }
          const updated = await authSteps.update({
            businessId: input.businessId,
            connectionId: input.connectionId,
            stepId: input.stepId,
            expectedRevision: input.expectedRevision,
            status: input.status,
            accessSlot: input.accessSlot,
            accessSecretRef: input.accessSecretRef,
            refreshSlot: input.refreshSlot,
            refreshSecretRef: input.refreshSecretRef,
            externalIdentity: input.externalIdentity,
            expiresAt: input.expiresAt,
            healthCheckedAt: input.healthCheckedAt,
          });
          if (updated === null) return false;
          current = {
            ...current,
            configuration: { ...current.configuration, ...input.configuration },
            secretBindings: { ...current.secretBindings, ...input.secretBindings },
            health: { status: "healthy", checkedAt: input.healthCheckedAt },
            expiresAt: input.expiresAt,
          };
          return true;
        },
        async markActionRequired() {
          return true;
        },
        async fenceRevocation() {
          current = { ...current, status: "revoked", isDefault: false };
          return current;
        },
      },
      authSteps,
      credentials,
      authRequests: requests,
      endpoints: {
        callbackUrl: "https://api.example.test/api/v1/integrations/auth/callback",
        webUrl: "https://app.example.test",
        apiUrl: "https://api.example.test",
      },
      refreshOAuth: async () => ({
        credentialValues: {},
        expiresAt: null,
        verifiedIdentity: {
          externalTenantId: "tenant-1",
          externalAccountId: "account-1",
          proofDigest: "a".repeat(64),
          verifiedAt: NOW.toISOString(),
          verifiedBy: "provider-profile",
        },
      }),
      verifyAuthorization: (input) => verify(input),
      now: () => NOW,
    });

    const action = await service.startAuthorization("acme-v2", "connection-1", "app", {
      principalId: "user-1",
      mayManageShared: false,
    });
    if (action.action !== "form_post") throw new Error("expected form_post");
    const state = requests.rows.values().next().value?.state;
    expect(state).toBeTruthy();
    expect(new URL(action.url).searchParams.get("state")).toBe(state);
    expect(JSON.parse(action.value).state).toBe(state);

    catalog[0] = { key: "acme-v2", manifest: manifest("Changed after review") };
    await expect(service.completeAuthorization({ state: state as string })).rejects.toMatchObject({
      reason: "invalid_state",
    });
    expect(create).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
    await expect(service.completeAuthorization({ state: state as string })).rejects.toMatchObject({
      reason: "invalid_state",
    });

    catalog[0] = { key: "acme-v2", manifest: manifest() };
    const forged = await service.startAuthorization("acme-v2", "connection-1", "app", {
      principalId: "user-1",
      mayManageShared: false,
    });
    if (forged.action !== "form_post") throw new Error("expected form_post");
    const forgedState = [...requests.rows.values()].at(-1)?.state;
    const forgedRequest = requests.rows.get(forgedState as string);
    if (forgedRequest === undefined) throw new Error("expected persisted request");
    requests.rows.set(forgedState as string, {
      ...forgedRequest,
      principal: { kind: "user", id: "user-2" },
    });
    await expect(
      service.completeAuthorization({
        state: forgedState as string,
        connectionId: "another-connection",
        stepId: "another-step",
      })
    ).rejects.toMatchObject({ reason: "invalid_state" });

    const older = await service.startAuthorization("acme-v2", "connection-1", "app", {
      principalId: "user-1",
      mayManageShared: false,
    });
    if (older.action !== "form_post") throw new Error("expected form_post");
    const olderState = [...requests.rows.values()].at(-1)?.state;
    const unverified = await service.startAuthorization("acme-v2", "connection-1", "app", {
      principalId: "user-1",
      mayManageShared: false,
    });
    if (unverified.action !== "form_post") throw new Error("expected form_post");
    const unverifiedState = [...requests.rows.values()].at(-1)?.state;
    await expect(
      service.completeAuthorization({ state: olderState as string, token: "stale" })
    ).rejects.toMatchObject({ reason: "invalid_state" });
    verify = async () => null;
    await expect(
      service.completeAuthorization({ state: unverifiedState as string, token: "forged" })
    ).rejects.toMatchObject({ reason: "invalid_state" });
    expect(create).not.toHaveBeenCalled();
    expect(current.secretBindings.app_token).toBe("secret://00000000-0000-4000-8000-000000000001");

    verify = async (input) => ({
      identity: verifiedIdentity,
      credentialValues: {
        ...input.candidateCredentialValues,
        app_token: verifiedToken,
      },
      configuration: input.candidateConfiguration,
      expiresAt: input.candidateExpiresAt,
    });
    const retry = await service.startAuthorization("acme-v2", "connection-1", "app", {
      principalId: "user-1",
      mayManageShared: false,
    });
    if (retry.action !== "form_post") throw new Error("expected form_post");
    const retryState = [...requests.rows.values()].at(-1)?.state;
    await expect(
      service.completeAuthorization({ state: retryState as string, token: "new-app" })
    ).resolves.toEqual({ key: "acme-v2", connectionId: "connection-1" });
    expect(authSteps.row.status).toBe("active");
    expect(rotate).not.toHaveBeenCalled();
    expect(current.secretBindings.app_token).toBe("secret://00000000-0000-4000-8000-000000000003");
    expect(values.get(current.secretBindings.app_token as string)).toBe("provider-confirmed-app");
    expect([...values.values()]).not.toContain("new-app");
    expect(revokeReferences).toHaveBeenCalledWith([
      "secret://00000000-0000-4000-8000-000000000001",
    ]);
    expect(current.health).toEqual({ status: "healthy", checkedAt: NOW.toISOString() });

    const boundRef = current.secretBindings.app_token;
    const mismatch = await service.startAuthorization("acme-v2", "connection-1", "app", {
      principalId: "user-1",
      mayManageShared: false,
    });
    if (mismatch.action !== "form_post") throw new Error("expected form_post");
    const mismatchState = [...requests.rows.values()].at(-1)?.state;
    verifiedIdentity = { ...verifiedIdentity, externalAccountId: "account-2" };
    verifiedToken = "account-two-token";
    await expect(
      service.completeAuthorization({ state: mismatchState as string, token: "account-two-token" })
    ).rejects.toMatchObject({ reason: "invalid_state" });
    expect(current.secretBindings.app_token).toBe(boundRef);
    expect([...values.values()]).not.toContain("account-two-token");

    verifiedIdentity = { ...verifiedIdentity, externalAccountId: "account-1" };
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    verify = async (input) => {
      enteredResolve?.();
      await release;
      return {
        identity: verifiedIdentity,
        credentialValues: input.candidateCredentialValues,
        configuration: input.candidateConfiguration,
        expiresAt: input.candidateExpiresAt,
      };
    };
    await service.startAuthorization("acme-v2", "connection-1", "app", {
      principalId: "user-1",
      mayManageShared: false,
    });
    const staleState = [...requests.rows.values()].at(-1)?.state;
    const staleCompletion = service.completeAuthorization({
      state: staleState as string,
      token: "stale-token",
    });
    await entered;
    verify = async (input) => ({
      identity: verifiedIdentity,
      credentialValues: input.candidateCredentialValues,
      configuration: input.candidateConfiguration,
      expiresAt: input.candidateExpiresAt,
    });
    await service.startAuthorization("acme-v2", "connection-1", "app", {
      principalId: "user-1",
      mayManageShared: false,
    });
    const winningState = [...requests.rows.values()].at(-1)?.state;
    releaseResolve?.();
    await expect(staleCompletion).rejects.toMatchObject({
      reason: "invalid_state",
    });
    expect([...values.values()]).not.toContain("stale-token");
    await expect(
      service.completeAuthorization({ state: winningState as string, token: "winning-token" })
    ).resolves.toEqual({ key: "acme-v2", connectionId: "connection-1" });
    expect(values.get(current.secretBindings.app_token as string)).toBe("winning-token");
  });
});
