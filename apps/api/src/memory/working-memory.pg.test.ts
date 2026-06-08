import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgWorkingMemoryRepo, type WorkingMemoryDoc } from "./working-memory";

const USER = "44444444-4444-4444-4444-444444444444";

function entry(overrides: Partial<WorkingMemoryDoc> = {}): WorkingMemoryDoc {
  const now = new Date();
  return {
    _id: randomUUID(),
    userId: USER,
    key: "fav-color",
    value: "blue",
    createdAt: now,
    lastWrittenAt: now,
    ...overrides,
  };
}

describe("PgWorkingMemoryRepo", () => {
  let db: PGlite;
  let repo: PgWorkingMemoryRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new PgWorkingMemoryRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("upserts then lists for the user", async () => {
    await repo.upsert(entry({ key: "k1", value: "v1" }));
    const list = await repo.listByUser(USER);
    expect(list).toHaveLength(1);
    expect(list[0].key).toBe("k1");
    expect(list[0].value).toBe("v1");
  });

  it("upsert on the same (user,key) updates value and preserves created_at", async () => {
    const t0 = new Date("2024-01-01T00:00:00.000Z");
    await repo.upsert(entry({ key: "k", value: "old", createdAt: t0, lastWrittenAt: t0 }));
    const t1 = new Date("2024-02-01T00:00:00.000Z");
    await repo.upsert(entry({ key: "k", value: "new", createdAt: t1, lastWrittenAt: t1 }));
    const list = await repo.listByUser(USER);
    expect(list).toHaveLength(1);
    expect(list[0].value).toBe("new");
    expect(list[0].createdAt.toISOString()).toBe(t0.toISOString());
    expect(list[0].lastWrittenAt.toISOString()).toBe(t1.toISOString());
  });

  it("lists oldest-written first (LRU order)", async () => {
    await repo.upsert(entry({ key: "older", lastWrittenAt: new Date("2024-01-01T00:00:00.000Z") }));
    await repo.upsert(entry({ key: "newer", lastWrittenAt: new Date("2024-03-01T00:00:00.000Z") }));
    expect((await repo.listByUser(USER)).map((e) => e.key)).toEqual(["older", "newer"]);
  });

  it("deleteByKey returns true when removed, false when absent", async () => {
    await repo.upsert(entry({ key: "k" }));
    expect(await repo.deleteByKey(USER, "k")).toBe(true);
    expect(await repo.deleteByKey(USER, "k")).toBe(false);
  });

  it("preserves writtenByAgentId when present", async () => {
    await repo.upsert(entry({ key: "k", writtenByAgentId: "agent-x" }));
    expect((await repo.listByUser(USER))[0].writtenByAgentId).toBe("agent-x");
  });
});
