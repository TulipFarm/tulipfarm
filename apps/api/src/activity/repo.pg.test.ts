import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { type ActivityRow, PgActivityRepo } from "./repo";

const USER = "44444444-4444-4444-4444-444444444444";

function row(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    _id: randomUUID(),
    category: "resource",
    action: "resource.created",
    actorType: "user",
    actorId: USER,
    targetType: "resource",
    targetId: "task-1",
    summary: "Created task-1",
    status: "ok",
    metadata: {},
    createdAt: new Date(),
    ...overrides,
  };
}

describe("PgActivityRepo", () => {
  let db: PGlite;
  let repo: PgActivityRepo;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    repo = new PgActivityRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("round-trips all columns incl. nested jsonb metadata and a Date timestamp", async () => {
    const r = row({
      metadata: { count: 3, ref: "abc", nested: { ids: ["a", "b"] } },
      status: "error",
    });
    await repo.insert(r);
    const page = await repo.list({ limit: 10 });
    expect(page.items).toHaveLength(1);
    const got = page.items[0];
    expect(got?._id).toBe(r._id);
    expect(got?.metadata).toEqual({ count: 3, ref: "abc", nested: { ids: ["a", "b"] } });
    expect(got?.status).toBe("error");
    expect(got?.actorType).toBe("user");
    expect(got?.actorId).toBe(USER);
    expect(got?.createdAt).toBeInstanceOf(Date);
  });

  it("stores a system row (null actor_id, null target)", async () => {
    await repo.insert(
      row({ actorType: "system", actorId: null, targetType: null, targetId: null })
    );
    const page = await repo.list({ limit: 10 });
    expect(page.items[0]?.actorType).toBe("system");
    expect(page.items[0]?.actorId).toBeNull();
    expect(page.items[0]?.targetType).toBeNull();
  });

  it("lists newest-first by created_at", async () => {
    const old = row({ summary: "old", createdAt: new Date("2024-01-01T00:00:00Z") });
    const mid = row({ summary: "mid", createdAt: new Date("2024-02-01T00:00:00Z") });
    const recent = row({ summary: "recent", createdAt: new Date("2024-03-01T00:00:00Z") });
    await repo.insert(old);
    await repo.insert(mid);
    await repo.insert(recent);
    const page = await repo.list({ limit: 10 });
    expect(page.items.map((i) => i.summary)).toEqual(["recent", "mid", "old"]);
  });

  it("keyset-paginates across pages with a stable order", async () => {
    // 5 rows at distinct timestamps.
    for (let i = 0; i < 5; i++) {
      await repo.insert(
        row({ summary: `a${i}`, createdAt: new Date(`2024-01-0${i + 1}T00:00:00Z`) })
      );
    }
    const first = await repo.list({ limit: 2 });
    expect(first.items.map((i) => i.summary)).toEqual(["a4", "a3"]);
    expect(first.nextCursor).not.toBeNull();

    const cursor = JSON.parse(Buffer.from(first.nextCursor as string, "base64").toString("utf8"));
    const second = await repo.list({
      limit: 2,
      after: { createdAt: new Date(cursor.createdAt), _id: cursor._id },
    });
    expect(second.items.map((i) => i.summary)).toEqual(["a2", "a1"]);

    const cursor2 = JSON.parse(Buffer.from(second.nextCursor as string, "base64").toString("utf8"));
    const third = await repo.list({
      limit: 2,
      after: { createdAt: new Date(cursor2.createdAt), _id: cursor2._id },
    });
    expect(third.items.map((i) => i.summary)).toEqual(["a0"]);
    expect(third.nextCursor).toBeNull();
  });

  it("breaks created_at ties deterministically by id (no row repeats across pages)", async () => {
    const ts = new Date("2024-05-01T00:00:00Z");
    for (let i = 0; i < 4; i++) await repo.insert(row({ summary: `t${i}`, createdAt: ts }));
    const first = await repo.list({ limit: 2 });
    const cursor = JSON.parse(Buffer.from(first.nextCursor as string, "base64").toString("utf8"));
    const second = await repo.list({
      limit: 2,
      after: { createdAt: new Date(cursor.createdAt), _id: cursor._id },
    });
    const ids = [...first.items, ...second.items].map((i) => i._id);
    expect(new Set(ids).size).toBe(4); // all distinct — no overlap at the tie boundary
  });

  it("filters by category", async () => {
    await repo.insert(row({ category: "resource", summary: "r" }));
    await repo.insert(row({ category: "chat", summary: "c" }));
    await repo.insert(row({ category: "job", summary: "j" }));
    const page = await repo.list({ limit: 10, category: "chat" });
    expect(page.items.map((i) => i.summary)).toEqual(["c"]);
  });
});
