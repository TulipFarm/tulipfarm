import { knowledgeManifestFixture } from "@tulipfarm/integrations/src/knowledge/oim-manifest.fixture";
import type { KnowledgeSourceRecord } from "@tulipfarm/knowledge";
import { decideSourceAccess } from "@tulipfarm/knowledge";
import type { OimManifest, OimOperation } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import type { PersistedConnection } from "@tulipfarm/storage";
import type { RequestContext } from "@tulipfarm/tool-host";
import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../broker/tool-adapter";
import { MemoryExternalIdentityRepo } from "../identity/fakes";
import { CompositeLiveSourceAuthorization } from "./live-authorization";
import { createOimLiveSourceAuthorization } from "./oim-live-authorization";

const NOW = new Date("2026-09-07T06:30:00.000Z");
const BUSINESS = "business-1";
const CONNECTION = "connection-b";
const USER = "user-1";

function manifest(
  overrides: Partial<OimOperation> = {},
  principalParameter: string | undefined = "accountId"
): OimManifest {
  const base = knowledgeManifestFixture({
    liveAuthorization: {
      operationId: "check-access",
      itemParameter: "id",
      parameters: { channel: "channel" },
      ...(principalParameter === undefined ? {} : { principalParameter }),
      allowedPointer: "/allowed",
    },
  });
  const operation: OimOperation = {
    ...base.operations[2],
    id: "check-access",
    name: "check_access",
    identityMode: "shared_or_personal",
    ...overrides,
  };
  return {
    ...base,
    profiles: { ...base.profiles, knowledge: "1.1" },
    operations: [...base.operations, operation],
    knowledge: {
      ...base.knowledge,
      list: {
        ...base.knowledge?.list,
        mapping: {
          ...base.knowledge?.list.mapping,
          itemFields: {
            channel: { source: "scope" },
            timestamp: { source: "item", pointer: "/id" },
          },
        },
      },
    },
  } as OimManifest;
}

function integration(value: OimManifest): SoulIntegration {
  return {
    slug: "wiki-install",
    sourceIntegration: "wiki-install",
    oimManifest: value,
  } as SoulIntegration;
}

function connection(overrides: Partial<PersistedConnection> = {}): PersistedConnection {
  return {
    id: CONNECTION,
    businessId: BUSINESS,
    integration: { id: "wiki", majorVersion: 2 },
    label: "Wiki B",
    owner: { scope: "organization" },
    status: "active",
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: { token: "secret://wiki-b" },
    health: { status: "healthy", checkedAt: null },
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function source(): KnowledgeSourceRecord {
  return {
    sourceId: "wiki:connection-b/1",
    businessId: BUSINESS,
    integrationId: "wiki-install",
    provider: "wiki",
    externalId: "1",
    externalTenantId: CONNECTION,
    ownerExternalId: "ENG",
    locator: {
      kind: "oim",
      integrationSlug: "wiki-install",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      connectionId: CONNECTION,
      sourceKindId: "space",
      scope: "ENG",
      itemId: "1",
      fields: { channel: "ENG", timestamp: "1" },
    },
    revision: "3",
    classification: ["internal"],
    status: "active",
    verification: "verified",
    accessControl: { mode: "live", maximumAgeSeconds: 60 },
    provenance: {
      capturedAt: NOW.toISOString(),
      contentHash: "a".repeat(64),
      connectionId: CONNECTION,
    },
    lastSyncedAt: NOW.toISOString(),
  };
}

function linkedIdentity(): MemoryExternalIdentityRepo {
  const identities = new MemoryExternalIdentityRepo();
  identities.mappings.push({
    provider: "wiki",
    externalSubject: "account-1",
    userId: USER,
    verifiedAt: NOW,
    expiresAt: null,
    verifiedVia: "bind_link",
  });
  return identities;
}

function harness(
  provider: (
    args: Record<string, unknown>,
    ctx: RequestContext
  ) => Promise<{ success: true; data: unknown }>,
  authorizeIntegration: (integration: SoulIntegration) => Promise<void> = async () => {}
) {
  const registry = new ToolRegistry({ defaultDeny: true });
  registry.register({
    name: "wiki_install_check_access",
    tier: "integration",
    mutating: false,
    description: "Check access",
    inputSchema: { type: "object" },
    execute: async (args, ctx) => provider((args ?? {}) as Record<string, unknown>, ctx),
  });
  let currentConnection = connection();
  const findById = vi.fn(async () => currentConnection);
  const auth = createOimLiveSourceAuthorization({
    integrations: () => [integration(manifest())],
    registry: () => registry,
    authorizeIntegration,
    connections: { findById },
    connectionAccess: { canUse: vi.fn(async () => true) },
    identities: linkedIdentity(),
    now: () => NOW,
  });
  return {
    auth,
    revoke: () => {
      currentConnection = connection({ status: "revoked" });
    },
    setConnection: (value: PersistedConnection) => {
      currentConnection = value;
    },
    findById,
  };
}

describe("OIM live Knowledge authorization", () => {
  it("rechecks the declared provider operation and follows permission updates", async () => {
    let allowed = true;
    const calls: {
      args: Record<string, unknown>;
      connectionId?: string;
      retryWaitPolicy?: RequestContext["retryWaitPolicy"];
    }[] = [];
    const { auth } = harness(async (args, ctx) => {
      calls.push({
        args,
        connectionId: typeof args.connection_id === "string" ? args.connection_id : undefined,
        retryWaitPolicy: ctx.retryWaitPolicy,
      });
      return { success: true, data: { allowed } };
    });

    const first = await decideSourceAccess(
      source(),
      { businessId: BUSINESS, principals: [{ kind: "user", id: USER }] },
      { live: auth },
      NOW
    );
    allowed = false;
    const second = await decideSourceAccess(
      source(),
      { businessId: BUSINESS, principals: [{ kind: "user", id: USER }] },
      { live: auth },
      NOW
    );

    expect(first.allowed).toBe(true);
    expect(second).toEqual({ allowed: false, reason: "live_check_denied" });
    expect(calls).toEqual([
      {
        args: {
          id: "1",
          channel: "ENG",
          accountId: "account-1",
          connection_id: CONNECTION,
        },
        connectionId: CONNECTION,
        retryWaitPolicy: "refuse",
      },
      {
        args: {
          id: "1",
          channel: "ENG",
          accountId: "account-1",
          connection_id: CONNECTION,
        },
        connectionId: CONNECTION,
        retryWaitPolicy: "refuse",
      },
    ]);
  });

  it("checks the linked provider identity against a declared principal set", async () => {
    const value = manifest();
    const principalSetManifest = {
      ...value,
      knowledge: {
        ...value.knowledge,
        liveAuthorization: {
          operationId: "check-access",
          parameters: { id: "channel" },
          principalSet: { entriesPointer: "/members", principalIdPointer: "" },
        },
      },
    } as OimManifest;
    let members: unknown[] = ["account-1"];
    const registry = new ToolRegistry({ defaultDeny: true });
    registry.register({
      name: "wiki_install_check_access",
      tier: "integration",
      mutating: false,
      description: "Check access",
      inputSchema: { type: "object" },
      execute: async () => ({ success: true, data: { members } }),
    });
    const auth = createOimLiveSourceAuthorization({
      integrations: () => [integration(principalSetManifest)],
      registry: () => registry,
      authorizeIntegration: async () => {},
      connections: { findById: async () => connection() },
      connectionAccess: { canUse: async () => true },
      identities: linkedIdentity(),
      now: () => NOW,
    });
    const request = {
      businessId: BUSINESS,
      principals: [{ kind: "user", id: USER }],
    };

    expect((await decideSourceAccess(source(), request, { live: auth }, NOW)).allowed).toBe(true);
    members = [];
    expect(await decideSourceAccess(source(), request, { live: auth }, NOW)).toEqual({
      allowed: false,
      reason: "live_check_denied",
    });
    members = ["account-1", {}];
    expect(await decideSourceAccess(source(), request, { live: auth }, NOW)).toEqual({
      allowed: false,
      reason: "live_check_denied",
    });
  });

  it("fails closed when a declared source field was not persisted", async () => {
    const provider = vi.fn(async () => ({ success: true as const, data: { allowed: true } }));
    const { auth } = harness(provider);
    const missingFields = source();
    if (missingFields.locator?.kind !== "oim") throw new Error("expected OIM locator");
    const withoutFields = {
      ...missingFields,
      locator: { ...missingFields.locator, fields: undefined },
    };

    expect(
      await decideSourceAccess(
        withoutFields,
        { businessId: BUSINESS, principals: [{ kind: "user", id: USER }] },
        { live: auth },
        NOW
      )
    ).toEqual({ allowed: false, reason: "live_check_denied" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("denies without leaking provider permission errors", async () => {
    const { auth } = harness(async () => {
      throw new Error("provider refused confidential-payroll-page");
    });
    const fallback = { check: vi.fn(async () => ({ allowed: true })) };

    const decision = await decideSourceAccess(
      source(),
      { businessId: BUSINESS, principals: [{ kind: "user", id: USER }] },
      { live: new CompositeLiveSourceAuthorization([auth, fallback]) },
      NOW
    );

    expect(decision).toEqual({ allowed: false, reason: "live_check_denied" });
    expect(JSON.stringify(decision)).not.toContain("confidential-payroll-page");
    expect(fallback.check).not.toHaveBeenCalled();
  });

  it("denies before provider access when installed release authorization fails", async () => {
    const provider = vi.fn(async () => ({ success: true as const, data: { allowed: true } }));
    const { auth } = harness(provider, async () => {
      throw new Error("revoked release details");
    });

    const decision = await decideSourceAccess(
      source(),
      { businessId: BUSINESS, principals: [{ kind: "user", id: USER }] },
      { live: auth },
      NOW
    );

    expect(decision).toEqual({ allowed: false, reason: "live_check_denied" });
    expect(JSON.stringify(decision)).not.toContain("revoked release details");
    expect(provider).not.toHaveBeenCalled();
  });

  it("denies immediately after the exact Connection is revoked", async () => {
    const provider = vi.fn(async () => ({ success: true as const, data: { allowed: true } }));
    const { auth, revoke } = harness(provider);
    const request = {
      businessId: BUSINESS,
      principals: [{ kind: "user", id: USER }],
    };

    expect((await decideSourceAccess(source(), request, { live: auth }, NOW)).allowed).toBe(true);
    revoke();
    expect(await decideSourceAccess(source(), request, { live: auth }, NOW)).toEqual({
      allowed: false,
      reason: "live_check_denied",
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("requires the locator's exact Connection account and Integration major", async () => {
    const provider = vi.fn(async () => ({ success: true as const, data: { allowed: true } }));
    const { auth, findById, setConnection } = harness(provider);
    const request = {
      businessId: BUSINESS,
      principals: [{ kind: "user", id: USER }],
    };
    setConnection(connection({ id: "connection-a" }));
    const wrongConnection = await decideSourceAccess(source(), request, { live: auth }, NOW);
    setConnection(connection({ integration: { id: "wiki", majorVersion: 3 } }));
    const wrongMajor = await decideSourceAccess(source(), request, { live: auth }, NOW);

    expect(findById).toHaveBeenCalledTimes(2);
    expect(findById).toHaveBeenNthCalledWith(1, BUSINESS, CONNECTION);
    expect(wrongConnection).toEqual({ allowed: false, reason: "live_check_denied" });
    expect(wrongMajor).toEqual({ allowed: false, reason: "live_check_denied" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("does not authorize a revoked Knowledge source", async () => {
    const provider = vi.fn(async () => ({ success: true as const, data: { allowed: true } }));
    const { auth } = harness(provider);

    const decision = await decideSourceAccess(
      { ...source(), status: "revoked" },
      { businessId: BUSINESS, principals: [{ kind: "user", id: USER }] },
      { live: auth },
      NOW
    );

    expect(decision).toEqual({ allowed: false, reason: "source_revoked" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("requires a proven linked provider identity", async () => {
    const provider = vi.fn(async () => ({ success: true as const, data: { allowed: true } }));
    const registry = new ToolRegistry({ defaultDeny: true });
    registry.register({
      name: "wiki_install_check_access",
      tier: "integration",
      mutating: false,
      description: "Check access",
      inputSchema: { type: "object" },
      execute: provider,
    });
    const identities = linkedIdentity();
    identities.mappings[0] = { ...identities.mappings[0], verifiedVia: "manifest_email" };
    const auth = createOimLiveSourceAuthorization({
      integrations: () => [integration(manifest())],
      registry: () => registry,
      authorizeIntegration: async () => {},
      connections: { findById: async () => connection() },
      connectionAccess: { canUse: async () => true },
      identities,
      now: () => NOW,
    });

    expect(
      await decideSourceAccess(
        source(),
        { businessId: BUSINESS, principals: [{ kind: "user", id: USER }] },
        { live: auth },
        NOW
      )
    ).toEqual({ allowed: false, reason: "live_check_denied" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("does not substitute a shared Connection for personal authorization", async () => {
    const provider = vi.fn(async () => ({ success: true as const, data: { allowed: true } }));
    const registry = new ToolRegistry({ defaultDeny: true });
    registry.register({
      name: "wiki_install_check_access",
      tier: "integration",
      mutating: false,
      description: "Check access",
      inputSchema: { type: "object" },
      execute: provider,
    });
    const personalManifest = manifest({ identityMode: "personal_required" }, undefined);
    const auth = createOimLiveSourceAuthorization({
      integrations: () => [integration(personalManifest)],
      registry: () => registry,
      authorizeIntegration: async () => {},
      connections: { findById: async () => connection() },
      connectionAccess: { canUse: async () => true },
      identities: linkedIdentity(),
      now: () => NOW,
    });

    expect(
      await decideSourceAccess(
        source(),
        { businessId: BUSINESS, principals: [{ kind: "user", id: USER }] },
        { live: auth },
        NOW
      )
    ).toEqual({ allowed: false, reason: "live_check_denied" });
    expect(provider).not.toHaveBeenCalled();
  });
});
