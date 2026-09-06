import { PGlite } from "@electric-sql/pglite";
import type { OimConnection } from "@tulipfarm/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import {
  CONNECTION_STORAGE_STATEMENTS,
  ConnectionIdentityConflictError,
  ConnectionStore,
} from "./connection-store";

const BUSINESS_ID = "business-1";
const OWNER_ID = "00000000-0000-4000-8000-000000000002";

function connection(id: string, overrides: Partial<OimConnection> = {}): OimConnection {
  return {
    id,
    integration: { id: "weather", majorVersion: 1 },
    label: `Weather ${id.at(-1)}`,
    owner: {
      scope: "personal",
      principalKind: "user",
      principalId: OWNER_ID,
    },
    status: "active",
    isDefault: false,
    configuration: { region: "us-east" },
    agentVisibleConfiguration: ["region"],
    secretBindings: { api_key: "secret://00000000-0000-4000-8000-000000000003" },
    health: { status: "unknown", checkedAt: null },
    expiresAt: null,
    ...overrides,
  };
}

describe("ConnectionStore", () => {
  let database: PGlite;
  let store: ConnectionStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of CONNECTION_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    store = new ConnectionStore(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE connections");
  });

  it("stores multiple named Connections with safe config and opaque Secret bindings", async () => {
    await store.put(BUSINESS_ID, connection("connection-1"));
    await store.put(BUSINESS_ID, connection("connection-2"));

    const rows = await store.listForOwner(
      BUSINESS_ID,
      { id: "weather", majorVersion: 1 },
      { scope: "personal", principalKind: "user", principalId: OWNER_ID }
    );

    expect(rows.map((row) => row.id)).toEqual(["connection-1", "connection-2"]);
    expect(rows[0]?.configuration).toEqual({ region: "us-east" });
    expect(rows[0]?.secretBindings).toEqual({
      api_key: "secret://00000000-0000-4000-8000-000000000003",
    });
    expect(JSON.stringify(rows)).not.toContain("plaintext");
  });

  it("keeps one active default per Integration major and owner scope", async () => {
    await store.put(BUSINESS_ID, connection("connection-1", { isDefault: true }));
    await store.put(BUSINESS_ID, connection("connection-2", { isDefault: true }));

    const rows = await store.listForOwner(
      BUSINESS_ID,
      { id: "weather", majorVersion: 1 },
      { scope: "personal", principalKind: "user", principalId: OWNER_ID }
    );

    expect(rows.map((row) => [row.id, row.isDefault])).toEqual([
      ["connection-2", true],
      ["connection-1", false],
    ]);
  });

  it("isolates personal owners, organization scope, and businesses", async () => {
    await store.put(BUSINESS_ID, connection("personal"));
    await store.put(
      BUSINESS_ID,
      connection("organization", {
        owner: { scope: "organization" },
      })
    );

    expect(
      await store.listForOwner(
        BUSINESS_ID,
        { id: "weather", majorVersion: 1 },
        {
          scope: "personal",
          principalKind: "user",
          principalId: "00000000-0000-4000-8000-000000000099",
        }
      )
    ).toEqual([]);
    expect(
      await store.listForOwner(
        "business-2",
        { id: "weather", majorVersion: 1 },
        { scope: "organization" }
      )
    ).toEqual([]);
  });

  it("isolates Team owners and keeps one default per exact Team", async () => {
    const firstTeam = { scope: "team" as const, teamId: "00000000-0000-4000-8000-000000000004" };
    const secondTeam = {
      scope: "team" as const,
      teamId: "00000000-0000-4000-8000-000000000005",
    };
    await store.put(BUSINESS_ID, connection("first", { owner: firstTeam, isDefault: true }));
    await store.put(BUSINESS_ID, connection("second", { owner: secondTeam, isDefault: true }));

    await expect(
      store.listForOwner(BUSINESS_ID, { id: "weather", majorVersion: 1 }, firstTeam)
    ).resolves.toMatchObject([{ id: "first", owner: firstTeam, isDefault: true }]);
    await expect(
      store.listForOwner(BUSINESS_ID, { id: "weather", majorVersion: 1 }, secondTeam)
    ).resolves.toMatchObject([{ id: "second", owner: secondTeam, isDefault: true }]);
  });

  it("preserves a Team owner when OAuth replaces its credential bindings", async () => {
    const owner = { scope: "team" as const, teamId: "00000000-0000-4000-8000-000000000004" };
    const initial = connection("oauth", { owner });
    await store.put(BUSINESS_ID, initial);
    await store.put(BUSINESS_ID, {
      ...initial,
      secretBindings: { api_key: "secret://00000000-0000-4000-8000-000000000006" },
    });

    await expect(store.findById(BUSINESS_ID, "oauth")).resolves.toMatchObject({
      owner,
      secretBindings: { api_key: "secret://00000000-0000-4000-8000-000000000006" },
    });
  });

  it("updates health and expiry without changing Secret bindings", async () => {
    await store.put(BUSINESS_ID, connection("connection-1"));
    await expect(
      store.updateHealth(
        BUSINESS_ID,
        "connection-1",
        { status: "expiring", checkedAt: "2026-08-16T12:00:00.000Z" },
        "2026-08-17T12:00:00.000Z"
      )
    ).resolves.toBe(true);

    const loaded = await store.findById(BUSINESS_ID, "connection-1");
    expect(loaded).toMatchObject({
      health: { status: "expiring", checkedAt: "2026-08-16T12:00:00.000Z" },
      expiresAt: "2026-08-17T12:00:00.000Z",
      secretBindings: { api_key: "secret://00000000-0000-4000-8000-000000000003" },
    });
  });

  it("lists only active Connections inside an OAuth renewal window", async () => {
    await store.put(
      BUSINESS_ID,
      connection("renew-now", { expiresAt: "2026-08-16T12:05:00.000Z" })
    );
    await store.put(BUSINESS_ID, connection("later", { expiresAt: "2026-08-16T13:00:00.000Z" }));
    await store.put(
      BUSINESS_ID,
      connection("revoked", {
        expiresAt: "2026-08-16T12:01:00.000Z",
        status: "revoked",
      })
    );
    await store.put(
      BUSINESS_ID,
      connection("needs-action", {
        expiresAt: "2026-08-16T12:01:00.000Z",
        health: { status: "action_required", checkedAt: "2026-08-16T12:00:00.000Z" },
      })
    );

    await expect(
      store.listExpiring(BUSINESS_ID, "2026-08-16T12:10:00.000Z")
    ).resolves.toMatchObject([{ id: "renew-now" }]);
  });

  it("revokes a Connection and removes it as the default", async () => {
    await store.put(BUSINESS_ID, connection("connection-1", { isDefault: true }));
    await expect(store.markRevoked(BUSINESS_ID, "connection-1")).resolves.toBe(true);
    await expect(store.markRevoked(BUSINESS_ID, "connection-1")).resolves.toBe(false);

    expect(await store.findById(BUSINESS_ID, "connection-1")).toMatchObject({
      status: "revoked",
      isDefault: false,
    });
  });

  it("does not let an existing Connection id move to another owner", async () => {
    await store.put(BUSINESS_ID, connection("connection-1"));

    await expect(
      store.put(
        BUSINESS_ID,
        connection("connection-1", {
          owner: {
            scope: "personal",
            principalKind: "user",
            principalId: "00000000-0000-4000-8000-000000000099",
          },
        })
      )
    ).rejects.toBeInstanceOf(ConnectionIdentityConflictError);
  });
});
