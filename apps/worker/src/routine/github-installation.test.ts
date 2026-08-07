import type { PersistedRoutingSnapshot } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { StoreGitHubInstallationDirectory } from "./github-installation";

const BUSINESS_ID = "biz-1";

function fakeStore(snapshot: PersistedRoutingSnapshot, onLoad?: () => void) {
  return {
    async loadProviderSnapshot(businessId: string, provider: string) {
      expect(businessId).toBe(BUSINESS_ID);
      expect(provider).toBe("github");
      onLoad?.();
      return snapshot;
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake, only `loadProviderSnapshot` is called
  } as any;
}

function snapshot(overrides: Partial<PersistedRoutingSnapshot> = {}): PersistedRoutingSnapshot {
  return {
    apps: [
      {
        id: "app-1",
        businessId: BUSINESS_ID,
        provider: "github",
        externalAppId: "123456",
        credentialRefs: [],
        status: "active",
      },
    ],
    integrations: [
      {
        id: "integration-1",
        businessId: BUSINESS_ID,
        appId: "app-1",
        externalTenantId: "install-1",
        externalAccountId: "tulip",
        status: "active",
      },
    ],
    accessGrants: [
      {
        id: "grant-1",
        businessId: BUSINESS_ID,
        integrationId: "integration-1",
        definition: {
          externalTargets: { ids: ["tulip/farm"] },
          permissions: { issues: "write", metadata: "read" },
        },
        status: "active",
      },
    ],
    routes: [],
    ...overrides,
  };
}

describe("StoreGitHubInstallationDirectory", () => {
  it("projects an active app/integration/grant triple into an installation record", async () => {
    const directory = new StoreGitHubInstallationDirectory(fakeStore(snapshot()), BUSINESS_ID);
    const records = await directory.list();
    expect(records).toEqual([
      {
        integrationId: "integration-1",
        installationId: "install-1",
        accountLogin: "tulip",
        appExternalId: "123456",
        repositories: ["tulip/farm"],
        permissions: { issues: "write", metadata: "read" },
      },
    ]);
  });

  it("falls back to the external tenant id when no account login is stored", async () => {
    const base = snapshot();
    const directory = new StoreGitHubInstallationDirectory(
      fakeStore({
        ...base,
        integrations: base.integrations.map((integration) => ({
          ...integration,
          externalAccountId: undefined,
        })),
      }),
      BUSINESS_ID
    );
    const [record] = await directory.list();
    expect(record?.accountLogin).toBe("install-1");
  });

  it("excludes a revoked integration", async () => {
    const base = snapshot();
    const directory = new StoreGitHubInstallationDirectory(
      fakeStore({
        ...base,
        integrations: base.integrations.map((integration) => ({
          ...integration,
          status: "revoked",
        })),
      }),
      BUSINESS_ID
    );
    expect(await directory.list()).toEqual([]);
  });

  it("excludes an integration whose app is revoked", async () => {
    const base = snapshot();
    const directory = new StoreGitHubInstallationDirectory(
      fakeStore({ ...base, apps: base.apps.map((app) => ({ ...app, status: "revoked" })) }),
      BUSINESS_ID
    );
    expect(await directory.list()).toEqual([]);
  });

  it("excludes an integration with no active access grant", async () => {
    const base = snapshot();
    const directory = new StoreGitHubInstallationDirectory(
      fakeStore({ ...base, accessGrants: [] }),
      BUSINESS_ID
    );
    expect(await directory.list()).toEqual([]);
  });

  it("ignores non-read/write permission values and non-string repository ids", async () => {
    const base = snapshot();
    const directory = new StoreGitHubInstallationDirectory(
      fakeStore({
        ...base,
        accessGrants: [
          {
            ...base.accessGrants[0],
            definition: {
              externalTargets: { ids: ["tulip/farm", 42] },
              permissions: { issues: "admin", metadata: "read" },
            },
          },
        ],
      }),
      BUSINESS_ID
    );
    const [record] = await directory.list();
    expect(record?.repositories).toEqual(["tulip/farm"]);
    expect(record?.permissions).toEqual({ metadata: "read" });
  });

  it("caches the listing until the TTL elapses", async () => {
    let loads = 0;
    let clock = new Date("2026-08-06T00:00:00.000Z").getTime();
    const directory = new StoreGitHubInstallationDirectory(
      fakeStore(snapshot(), () => {
        loads += 1;
      }),
      BUSINESS_ID,
      { now: () => new Date(clock), ttlMs: 30_000 }
    );

    await directory.list();
    expect(loads).toBe(1);

    clock += 10_000;
    await directory.list();
    expect(loads).toBe(1);

    clock += 30_000;
    await directory.list();
    expect(loads).toBe(2);
  });
});
