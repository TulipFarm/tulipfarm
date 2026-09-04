import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { PGlite } from "@electric-sql/pglite";
import type { SoulResource } from "@tulipfarm/soul";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { reconcileResourceTables, registerResourceReconcile } from "./reconcile";

function fakeResource(schema: Record<string, unknown> = {}): SoulResource {
  return { name: "test", schema, hasHooks: false, hooksEnabled: false };
}

function soulOf(...types: string[]): { resources: Map<string, SoulResource> } {
  return { resources: new Map(types.map((t) => [t, fakeResource()])) };
}

async function insertResource(db: PGlite, type: string): Promise<void> {
  await db.query(
    `INSERT INTO resources."${type}" (id, version, created_at, updated_at, data)
     VALUES ($1, 1, now(), now(), $2::jsonb)`,
    [randomUUID(), JSON.stringify({ title: "x" })]
  );
}

async function count(db: PGlite, type: string): Promise<number> {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM resources."${type}"`);
  return (rows[0] as { n: number }).n;
}

describe("reconcileResourceTables", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await makeMigratedPglite();
  });
  afterEach(async () => {
    await db.close();
  });

  it("creates the per-type table and its history table", async () => {
    await reconcileResourceTables(db, soulOf("ticket"));
    await insertResource(db, "ticket");
    expect(await count(db, "ticket")).toBe(1);
    await db.query(
      `INSERT INTO resources."ticket_history" (id, resource_id, operation, snapshot, at)
       VALUES ($1, $2, 'create', $3::jsonb, now())`,
      [randomUUID(), randomUUID(), JSON.stringify({ title: "x" })]
    );
  });

  it("is idempotent — re-running does not drop existing rows", async () => {
    await reconcileResourceTables(db, soulOf("ticket"));
    await insertResource(db, "ticket");
    await reconcileResourceTables(db, soulOf("ticket"));
    expect(await count(db, "ticket")).toBe(1);
  });

  it("handles hyphenated type names", async () => {
    await reconcileResourceTables(db, soulOf("support-ticket"));
    await insertResource(db, "support-ticket");
    expect(await count(db, "support-ticket")).toBe(1);
  });

  it("skips an invalid type name and still creates the valid ones", async () => {
    const warn = vi.fn();
    await reconcileResourceTables(db, soulOf("BadType", "ticket"), { warn });
    expect(warn).toHaveBeenCalledOnce();
    await insertResource(db, "ticket");
    expect(await count(db, "ticket")).toBe(1);
  });

  it("materializes an x-unique index that rejects a duplicate on the named field", async () => {
    const soul = {
      resources: new Map([["ticket", fakeResource({ "x-unique": [["title"]] })]]),
    };
    await reconcileResourceTables(db, soul);
    await insertResource(db, "ticket");
    await expect(insertResource(db, "ticket")).rejects.toThrow(/unique/i);
  });
});

describe("registerResourceReconcile", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await makeMigratedPglite();
  });
  afterEach(async () => {
    await db.close();
  });

  it("reloads soul and reconciles tables on soul.synced", async () => {
    const gitSync = new EventEmitter();
    const soul = {
      resources: new Map<string, SoulResource>(),
      reload: vi.fn(async () => {
        soul.resources.set("ticket", fakeResource());
      }),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    registerResourceReconcile(gitSync, soul, db, logger);

    gitSync.emit("soul.synced");

    await vi.waitFor(async () => {
      const { rows } = await db.query(`SELECT to_regclass('resources."ticket"') AS t`);
      expect((rows[0] as { t: string | null }).t).not.toBeNull();
    });
    expect(soul.reload).toHaveBeenCalledOnce();
  });
});
