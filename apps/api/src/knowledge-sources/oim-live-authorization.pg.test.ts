import type { PGlite } from "@electric-sql/pglite";
import type { LiveSourceAuthorizationPort, OimKnowledgeSourceLocator } from "@tulipfarm/knowledge";
import type { OimConnection } from "@tulipfarm/schema";
import {
  ConnectionExternalIdentityStore,
  ConnectionStore,
  transactionPort,
} from "@tulipfarm/storage";
import { afterEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { createOimLiveSourceAuthorization } from "./oim-live-authorization";

const NOW = new Date("2026-09-13T10:00:00.000Z");

const connection: OimConnection = {
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
};

const locator: OimKnowledgeSourceLocator = {
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
};

const request: Parameters<LiveSourceAuthorizationPort["check"]>[0] = {
  businessId: "business-1",
  sourceId: "wiki:connection-1/page-1",
  provider: "wiki",
  externalId: "page-1",
  externalTenantId: "tenant-b",
  sourceLocator: locator,
  principals: [{ kind: "user", id: "user-1" }],
};

describe("OIM live Knowledge authorization persistence", () => {
  let database: PGlite | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("does not use an identical subject proven in another provider tenant", async () => {
    database = await makeMigratedPglite();
    const transactions = transactionPort(database);
    const connections = new ConnectionStore(transactions);
    const identities = new ConnectionExternalIdentityStore(transactions);
    await connections.put("business-1", connection);
    await identities.bindVerified({
      businessId: "business-1",
      connectionId: "connection-1",
      integrationId: "wiki",
      integrationMajorVersion: 2,
      externalTenantId: "tenant-b",
      externalAccountId: "account-b",
      proofKind: "auth",
      proofDigest: "a".repeat(64),
      verifiedAt: NOW.toISOString(),
      verifiedBy: "provider-auth",
    });

    let providerCalls = 0;
    const authorization = createOimLiveSourceAuthorization({
      connections,
      connectionIdentities: identities,
      connectionAccess: {
        async canUse() {
          return true;
        },
      },
      identities: {
        async listProvenMappingsForUser() {
          return [
            {
              provider: "wiki",
              externalSubject: "same-subject",
              externalTenantId: "tenant-a",
              userId: "user-1",
              verifiedAt: NOW,
              expiresAt: null,
              verifiedVia: "bind_link",
            },
          ];
        },
      },
      provider: {
        async check() {
          providerCalls += 1;
          return { allowed: true };
        },
      },
      now: () => NOW,
    });

    await expect(authorization.check(request)).resolves.toEqual({ allowed: false });
    expect(providerCalls).toBe(0);
  });
});
