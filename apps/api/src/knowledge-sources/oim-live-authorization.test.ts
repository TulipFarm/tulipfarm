import type { LiveSourceAuthorizationPort, OimKnowledgeSourceLocator } from "@tulipfarm/knowledge";
import type { PersistedConnection, VerifiedConnectionExternalIdentity } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import {
  createOimLiveSourceAuthorization,
  type OimLiveSourceAuthorizationDeps,
} from "./oim-live-authorization";

const NOW = new Date("2026-09-13T10:00:00.000Z");

function connection(): PersistedConnection {
  return {
    businessId: "business-1",
    id: "connection-1",
    integration: { id: "wiki", majorVersion: 2 },
    label: "Wiki",
    owner: { scope: "organization" },
    status: "active",
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "healthy", checkedAt: NOW.toISOString() },
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function proof(): VerifiedConnectionExternalIdentity {
  return {
    businessId: "business-1",
    connectionId: "connection-1",
    integrationId: "wiki",
    integrationMajorVersion: 2,
    externalTenantId: "tenant-b",
    externalAccountId: "account-b",
    proofKind: "auth",
    proofDigest: "a".repeat(64),
    verifiedAt: NOW.toISOString(),
    verifiedBy: "auth-step",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function locator(overrides: Partial<OimKnowledgeSourceLocator> = {}): OimKnowledgeSourceLocator {
  return {
    kind: "oim",
    integrationSlug: "wiki-install",
    integrationId: "wiki",
    integrationMajorVersion: 2,
    connectionId: "connection-1",
    externalTenantId: "tenant-b",
    externalAccountId: "account-b",
    sourceKindId: "page",
    scope: "space-1",
    itemId: "page-1",
    ...overrides,
  };
}

function request(
  sourceLocator: OimKnowledgeSourceLocator
): Parameters<LiveSourceAuthorizationPort["check"]>[0] {
  return {
    businessId: "business-1",
    sourceId: "wiki:connection-1/page-1",
    provider: "wiki",
    externalId: "page-1",
    externalTenantId: "tenant-b",
    sourceLocator,
    principals: [{ kind: "user", id: "user-1" }],
  };
}

function dependencies(
  mappings: OimLiveSourceAuthorizationDeps["identities"]["listProvenMappingsForUser"]
): OimLiveSourceAuthorizationDeps {
  return {
    connections: {
      async findById() {
        return connection();
      },
    },
    connectionIdentities: {
      async find() {
        return proof();
      },
    },
    connectionAccess: {
      async canUse() {
        return true;
      },
    },
    identities: { listProvenMappingsForUser: mappings },
    provider: {
      async check() {
        return { allowed: true, aclRevision: "live-2" };
      },
    },
    now: () => NOW,
  };
}

describe("OIM live Knowledge authorization", () => {
  it("does not let an identical provider subject from tenant A authorize tenant B", async () => {
    let providerCalls = 0;
    const deps = dependencies(async () => [
      {
        provider: "wiki",
        externalSubject: "same-subject",
        externalTenantId: "tenant-a",
        userId: "user-1",
        verifiedAt: NOW,
        expiresAt: null,
        verifiedVia: "bind_link",
      },
    ]);
    deps.provider.check = async () => {
      providerCalls += 1;
      return { allowed: true };
    };

    await expect(createOimLiveSourceAuthorization(deps).check(request(locator()))).resolves.toEqual(
      {
        allowed: false,
      }
    );
    expect(providerCalls).toBe(0);
  });

  it("authorizes only through the exact verified Connection proof and tenant-scoped link", async () => {
    const deps = dependencies(async () => [
      {
        provider: "wiki",
        externalSubject: "subject-b",
        externalTenantId: "tenant-b",
        userId: "user-1",
        verifiedAt: NOW,
        expiresAt: null,
        verifiedVia: "link_token",
      },
    ]);

    await expect(createOimLiveSourceAuthorization(deps).check(request(locator()))).resolves.toEqual(
      {
        allowed: true,
        aclRevision: "live-2",
      }
    );
  });

  it("denies when the persisted provider proof does not match the source locator", async () => {
    const deps = dependencies(async () => [
      {
        provider: "wiki",
        externalSubject: "subject-b",
        externalTenantId: "tenant-b",
        userId: "user-1",
        verifiedAt: NOW,
        expiresAt: null,
        verifiedVia: "link_token",
      },
    ]);

    await expect(
      createOimLiveSourceAuthorization(deps).check(
        request(locator({ externalAccountId: "forged-account" }))
      )
    ).resolves.toEqual({ allowed: false });
  });

  it("denies a locator transplanted onto a different source", async () => {
    const deps = dependencies(async () => [
      {
        provider: "wiki",
        externalSubject: "subject-b",
        externalTenantId: "tenant-b",
        userId: "user-1",
        verifiedAt: NOW,
        expiresAt: null,
        verifiedVia: "link_token",
      },
    ]);

    await expect(
      createOimLiveSourceAuthorization(deps).check({
        ...request(locator()),
        sourceId: "wiki:connection-1/page-2",
      })
    ).resolves.toEqual({ allowed: false });
  });

  it("denies an unproven browser identity even when a repository returns it", async () => {
    const deps = dependencies(async () => [
      {
        provider: "wiki",
        externalSubject: "subject-b",
        externalTenantId: "tenant-b",
        userId: "user-1",
        verifiedAt: NOW,
        expiresAt: null,
        verifiedVia: "manifest_email",
      },
    ]);

    await expect(createOimLiveSourceAuthorization(deps).check(request(locator()))).resolves.toEqual(
      {
        allowed: false,
      }
    );
  });

  it("denies a proven mapping that belongs to another TulipFarm user", async () => {
    let providerCalls = 0;
    const deps = dependencies(async () => [
      {
        provider: "wiki",
        externalSubject: "subject-b",
        externalTenantId: "tenant-b",
        userId: "user-2",
        verifiedAt: NOW,
        expiresAt: null,
        verifiedVia: "link_token",
      },
    ]);
    deps.provider.check = async () => {
      providerCalls += 1;
      return { allowed: true };
    };

    await expect(createOimLiveSourceAuthorization(deps).check(request(locator()))).resolves.toEqual(
      {
        allowed: false,
      }
    );
    expect(providerCalls).toBe(0);
  });
});
