import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { decodeCursor } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { PgResourceRepo, type ResourceDoc, type ResourceHistoryDoc } from "./repo";
import { createHistoryTableSql, createResourceTableSql } from "./schema";

const TYPE = "ticket";

function doc(overrides: Partial<ResourceDoc> = {}): ResourceDoc {
  const now = new Date();
  return {
    _id: randomUUID(),
    version: 1,
    createdAt: now,
    updatedAt: now,
    title: "Bug",
    ...overrides,
  };
}

describe("PgResourceRepo", () => {
  let db: PGlite;
  let repo: PgResourceRepo;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    await db.query(createResourceTableSql(TYPE));
    await db.query(createHistoryTableSql(TYPE));
    repo = new PgResourceRepo(db, TYPE);
  });

  afterEach(async () => {
    await db.close();
  });

  it("round-trips a record through jsonb data, including nested fields", async () => {
    const created = new Date("2026-06-01T10:00:00Z");
    const d = doc({
      createdAt: created,
      updatedAt: created,
      title: "Bug",
      priority: "high",
      meta: { tags: ["a", "b"], n: 3 },
    });
    await repo.insert(d);

    const found = await repo.findById(d._id);
    expect(found).not.toBeNull();
    expect(found?._id).toBe(d._id);
    expect(found?.version).toBe(1);
    expect((found?.createdAt as Date)?.getTime()).toBe(created.getTime());
    expect(found?.title).toBe("Bug");
    expect(found?.priority).toBe("high");
    expect(found?.meta).toEqual({ tags: ["a", "b"], n: 3 });
    expect("deletedAt" in (found as ResourceDoc)).toBe(false);
  });

  it("returns null for a missing id", async () => {
    expect(await repo.findById(randomUUID())).toBeNull();
  });

  it("returns null for a malformed id without querying the UUID column", async () => {
    expect(await repo.findById("qa-does-not-exist-id")).toBeNull();
  });

  it("list excludes soft-deleted by default and includes them on demand", async () => {
    await repo.insert(doc({ title: "live" }));
    await repo.insert(doc({ title: "gone", version: 2, deletedAt: new Date() }));

    const def = await repo.list({ limit: 10 });
    expect(def.items).toHaveLength(1);
    expect(def.items[0].title).toBe("live");

    const all = await repo.list({ limit: 10, includeDeleted: true });
    expect(all.items).toHaveLength(2);
  });

  it("replaceOne enforces optimistic version (409 on mismatch)", async () => {
    const d = doc();
    await repo.insert(d);

    const wrong = await repo.replaceOne(d._id, 99, { ...d, version: 100, title: "nope" });
    expect(wrong).toBe(false);

    const next = { ...d, version: 2, title: "updated", updatedAt: new Date() };
    const ok = await repo.replaceOne(d._id, 1, next);
    expect(ok).toBe(true);

    const found = await repo.findById(d._id);
    expect(found?.version).toBe(2);
    expect(found?.title).toBe("updated");
  });

  it("replaceOne rejects a malformed id without querying the UUID column", async () => {
    const d = doc();
    await repo.insert(d);

    expect(await repo.replaceOne("qa-does-not-exist-id", 1, d)).toBe(false);
  });

  it("appendHistory writes a snapshot row", async () => {
    const d = doc();
    await repo.insert(d);
    const entry: ResourceHistoryDoc = {
      _id: randomUUID(),
      resourceId: d._id,
      operation: "create",
      snapshot: d,
      at: new Date(),
    };
    await repo.appendHistory(entry);

    const { rows } = await db.query(
      `SELECT operation, snapshot FROM resources."${TYPE}_history" WHERE resource_id = $1`,
      [d._id]
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { operation: string }).operation).toBe("create");
    expect((rows[0] as { snapshot: { title: string } }).snapshot.title).toBe("Bug");
  });

  it("paginates by keyset in created order", async () => {
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      await repo.insert(doc({ title: `t${i}`, createdAt: new Date(base + i * 1000) }));
    }

    const page1 = await repo.list({ limit: 2 });
    expect(page1.items.map((r) => r.title)).toEqual(["t0", "t1"]);
    expect(page1.nextCursor).not.toBeNull();

    const after = decodeCursor(page1.nextCursor as string);
    const page2 = await repo.list({ limit: 2, after: after ?? undefined });
    expect(page2.items.map((r) => r.title)).toEqual(["t2"]);
    expect(page2.nextCursor).toBeNull();
  });
});
