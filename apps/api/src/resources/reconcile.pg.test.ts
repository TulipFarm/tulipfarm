import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { PGlite } from "@electric-sql/pglite";
import type { SoulResource } from "@tulipfarm/soul";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../db";
import { makeMigratedPglite } from "../test/pglite";
import {
  reconcileResourceTables,
  reconcileResourceTablesRecoverably,
  registerResourceReconcile,
  resourceWriteBlock,
} from "./reconcile";

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

async function insertData(db: PGlite, type: string, data: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO resources."${type}" (id, version, created_at, updated_at, data)
     VALUES ($1, 1, now(), now(), $2::jsonb)`,
    [randomUUID(), JSON.stringify(data)]
  );
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

  it("rejects an invalid type name in strict reconciliation", async () => {
    const warn = vi.fn();
    await expect(
      reconcileResourceTables(db, soulOf("BadType", "ticket"), { warn })
    ).rejects.toThrow(/invalid resource type name/);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("materializes an x-unique index that rejects a duplicate on the named field", async () => {
    const soul = {
      resources: new Map([["ticket", fakeResource({ "x-unique": [["title"]] })]]),
    };
    await reconcileResourceTables(db, soul);
    await insertResource(db, "ticket");
    await expect(insertResource(db, "ticket")).rejects.toThrow(/unique/i);
  });

  it("removes an owned x-unique index when the schema removes the constraint", async () => {
    await reconcileResourceTables(db, {
      resources: new Map([["ticket", fakeResource({ "x-unique": [["title"]] })]]),
    });
    await reconcileResourceTables(db, soulOf("ticket"));

    await insertResource(db, "ticket");
    await expect(insertResource(db, "ticket")).resolves.toBeUndefined();
  });

  it("preserves custom indexes that merely share the generated index prefix", async () => {
    const soul = soulOf("ticket");
    await reconcileResourceTables(db, soul);
    await db.query(`CREATE UNIQUE INDEX uniq_ticket_custom ON resources.ticket ((data->>'title'))`);

    await reconcileResourceTables(db, soul);
    await insertResource(db, "ticket");
    await expect(insertResource(db, "ticket")).rejects.toThrow(/unique/i);
  });

  it("replaces an owned x-unique index when the constrained fields change", async () => {
    await reconcileResourceTables(db, {
      resources: new Map([["ticket", fakeResource({ "x-unique": [["title"]] })]]),
    });
    await reconcileResourceTables(db, {
      resources: new Map([["ticket", fakeResource({ "x-unique": [["code"]] })]]),
    });

    await insertData(db, "ticket", { title: "same", code: "A" });
    await insertData(db, "ticket", { title: "same", code: "B" });
    await expect(insertData(db, "ticket", { title: "different", code: "A" })).rejects.toThrow(
      /unique/i
    );
  });

  it("surfaces duplicate data and rolls back a failed constraint change", async () => {
    await reconcileResourceTables(db, {
      resources: new Map([["ticket", fakeResource({ "x-unique": [["title"]] })]]),
    });
    await insertData(db, "ticket", { title: "one", code: "duplicate" });
    await insertData(db, "ticket", { title: "two", code: "duplicate" });

    await expect(
      reconcileResourceTables(db, {
        resources: new Map([["ticket", fakeResource({ "x-unique": [["code"]] })]]),
      })
    ).rejects.toThrow(/unique/i);
    await expect(insertData(db, "ticket", { title: "one", code: "different" })).rejects.toThrow(
      /unique/i
    );
  });

  it("replaces a PostgreSQL-truncated legacy index name for a long type", async () => {
    const type = `a${"b".repeat(54)}`;
    await reconcileResourceTables(db, soulOf(type));
    const fieldHash = createHash("sha256").update("title").digest("hex").slice(0, 12);
    const legacyName = `uniq_${type}_${fieldHash}`;
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${legacyName}"
         ON resources."${type}" ((data->>'title')) WHERE deleted_at IS NULL`
    );

    await reconcileResourceTables(db, {
      resources: new Map([[type, fakeResource({ "x-unique": [["title"]] })]]),
    });

    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'resources' AND tablename = $1 AND indexname LIKE 'uniq_%'`,
      [type]
    );
    expect(indexes.rows).toHaveLength(1);
    expect(Buffer.byteLength(indexes.rows[0]?.indexname ?? "")).toBeLessThanOrEqual(63);
    expect(indexes.rows[0]?.indexname).not.toBe(legacyName.slice(0, 63));
  });

  it("continues reconciling other types while reporting an unenforceable schema", async () => {
    await reconcileResourceTables(db, soulOf("broken"));
    await insertData(db, "broken", { title: "duplicate" });
    await insertData(db, "broken", { title: "duplicate" });
    const logger = { warn: vi.fn(), error: vi.fn() };
    const soul = {
      resources: new Map([
        ["broken", fakeResource({ "x-unique": [["title"]] })],
        ["healthy", fakeResource()],
      ]),
    };

    const failures = await reconcileResourceTablesRecoverably(db, soul, logger);

    expect(failures).toEqual([
      {
        type: "broken",
        message: expect.stringMatching(/unique/i),
      },
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/reconcile failed for type "broken".*unique/i)
    );
    expect(resourceWriteBlock(soul, "broken")).toMatch(/not enforced/i);
    expect(resourceWriteBlock(soul, "healthy")).toBeUndefined();
    await insertResource(db, "healthy");
    expect(await count(db, "healthy")).toBe(1);

    soul.resources.set("broken", fakeResource());
    await reconcileResourceTablesRecoverably(db, soul, logger);
    expect(resourceWriteBlock(soul, "broken")).toBeUndefined();
  });

  it("keeps boot recoverable while blocking invalid SQL type names", async () => {
    const invalid = "BadType";
    const soul = soulOf(invalid, "healthy");
    const failures = await reconcileResourceTablesRecoverably(db, soul, {
      warn: vi.fn(),
      error: vi.fn(),
    });

    expect(failures).toEqual([
      { type: invalid, message: expect.stringMatching(/invalid resource type name/) },
    ]);
    expect(resourceWriteBlock(soul, invalid)).toMatch(/not enforced/i);
    expect(resourceWriteBlock(soul, "healthy")).toBeUndefined();
    await insertResource(db, "healthy");
    expect(await count(db, "healthy")).toBe(1);
  });

  it("blocks a changed uniqueness shape until that exact schema reconciles", async () => {
    const soul = soulOf("ticket");
    await reconcileResourceTables(db, soul);
    expect(resourceWriteBlock(soul, "ticket")).toBeUndefined();

    soul.resources.set("ticket", fakeResource({ "x-unique": [["title"]] }));
    expect(resourceWriteBlock(soul, "ticket")).toMatch(/not ready/i);

    await reconcileResourceTables(db, soul);
    expect(resourceWriteBlock(soul, "ticket")).toBeUndefined();
  });

  it("serializes overlapping reconciliation for the same type", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resourceTableCreates = 0;
    const q = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS resources."ticket" (')) {
          resourceTableCreates += 1;
          if (resourceTableCreates === 1) {
            markFirstStarted();
            await firstBlocked;
          }
        }
        return { rows: [] };
      }),
    } as unknown as Queryable & {
      transaction<T>(callback: (tx: Queryable) => Promise<T>): Promise<T>;
    };
    q.transaction = async (callback) => callback(q);

    const first = reconcileResourceTables(q, soulOf("ticket"));
    await firstStarted;
    const second = reconcileResourceTables(q, soulOf("ticket"));
    await Promise.resolve();

    expect(resourceTableCreates).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(resourceTableCreates).toBe(2);
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

  it("reconciles healthy types after a soul.synced type fails", async () => {
    await reconcileResourceTables(db, soulOf("broken"));
    await insertData(db, "broken", { title: "duplicate" });
    await insertData(db, "broken", { title: "duplicate" });
    const gitSync = new EventEmitter();
    const soul = {
      resources: new Map<string, SoulResource>(),
      reload: vi.fn(async () => {
        soul.resources.set("broken", fakeResource({ "x-unique": [["title"]] }));
        soul.resources.set("healthy", fakeResource());
      }),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    registerResourceReconcile(gitSync, soul, db, logger);

    gitSync.emit("soul.synced");

    await vi.waitFor(async () => {
      const { rows } = await db.query(`SELECT to_regclass('resources."healthy"') AS t`);
      expect((rows[0] as { t: string | null }).t).not.toBeNull();
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/reconcile failed for type "broken".*unique/i)
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});
