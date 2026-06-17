import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { type KvEntry, PgKvRepo } from "./repo";

const USER = "44444444-4444-4444-4444-444444444444";

function entry(overrides: Partial<KvEntry> = {}): KvEntry {
  const now = new Date();
  return {
    scope: "user",
    ownerId: USER,
    namespace: "prefs",
    key: "theme",
    value: { mode: "dark" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("PgKvRepo", () => {
  let db: PGlite;
  let repo: PgKvRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new PgKvRepo(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("round-trips arbitrary JSON (incl. nested) and Date timestamps", async () => {
    await repo.upsert(entry({ value: { mode: "dark", tags: ["a", "b"], n: 3, nested: { x: 1 } } }));
    const found = await repo.get("user", USER, "prefs", "theme");
    expect(found?.value).toEqual({ mode: "dark", tags: ["a", "b"], n: 3, nested: { x: 1 } });
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.updatedAt).toBeInstanceOf(Date);
    expect(found?.ownerId).toBe(USER);
    expect(found?.scope).toBe("user");
  });

  it("stores primitive and null JSON values", async () => {
    await repo.upsert(entry({ key: "s", value: "just-a-string" }));
    await repo.upsert(entry({ key: "z", value: null }));
    expect((await repo.get("user", USER, "prefs", "s"))?.value).toBe("just-a-string");
    expect((await repo.get("user", USER, "prefs", "z"))?.value).toBeNull();
  });

  it("last-write-wins update replaces value, advances updated_at, preserves created_at", async () => {
    const t0 = new Date("2024-01-01T00:00:00.000Z");
    await repo.upsert(entry({ value: "old", createdAt: t0, updatedAt: t0 }));
    const t1 = new Date("2024-02-01T00:00:00.000Z");
    await repo.upsert(entry({ value: "new", createdAt: t1, updatedAt: t1 }));
    const found = await repo.get("user", USER, "prefs", "theme");
    expect(found?.value).toBe("new");
    expect(found?.createdAt.toISOString()).toBe(t0.toISOString());
    expect(found?.updatedAt.toISOString()).toBe(t1.toISOString());
  });

  it("upserts a system-scoped entry via ownerId=undefined and never surfaces the sentinel", async () => {
    await repo.upsert(
      entry({ scope: "system", ownerId: undefined, namespace: "cfg", key: "salt" })
    );
    await repo.upsert(
      entry({ scope: "system", ownerId: undefined, namespace: "cfg", key: "salt", value: "v2" })
    );
    const found = await repo.get("system", undefined, "cfg", "salt");
    expect(found?.value).toBe("v2");
    expect(found?.ownerId).toBeUndefined(); // '' sentinel maps back to undefined
    // ON CONFLICT fired: exactly one system row.
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM kv_store WHERE scope = 'system'"
    );
    expect(Number((rows[0] as { n: number }).n)).toBe(1);
  });

  it("lazy expiry: a past expiresAt is treated as absent on get/list/delete", async () => {
    const past = new Date(Date.now() - 60_000);
    await repo.upsert(entry({ key: "gone", expiresAt: past }));
    expect(await repo.get("user", USER, "prefs", "gone")).toBeNull();
    expect(await repo.listByNamespace("user", USER, "prefs")).toHaveLength(0);
    expect(await repo.delete("user", USER, "prefs", "gone")).toBe(false);
  });

  it("a future expiresAt is still live", async () => {
    const future = new Date(Date.now() + 60_000);
    await repo.upsert(entry({ key: "live", expiresAt: future }));
    const found = await repo.get("user", USER, "prefs", "live");
    expect(found?.value).toEqual({ mode: "dark" });
    expect(found?.expiresAt).toBeInstanceOf(Date);
  });

  it("isolates scopes: same (namespace,key) under user vs agent are distinct rows", async () => {
    await repo.upsert(entry({ scope: "user", ownerId: USER, value: "user-val" }));
    await repo.upsert(entry({ scope: "agent", ownerId: USER, value: "agent-val" }));
    expect((await repo.get("user", USER, "prefs", "theme"))?.value).toBe("user-val");
    expect((await repo.get("agent", USER, "prefs", "theme"))?.value).toBe("agent-val");
  });

  it("prevents cross-owner reads (get for another owner returns null)", async () => {
    await repo.upsert(entry({ ownerId: USER, value: "mine" }));
    expect(await repo.get("user", "other-owner", "prefs", "theme")).toBeNull();
  });

  it("delete is idempotent: true when present, false when already gone", async () => {
    await repo.upsert(entry({ key: "k" }));
    expect(await repo.delete("user", USER, "prefs", "k")).toBe(true);
    expect(await repo.delete("user", USER, "prefs", "k")).toBe(false);
  });

  it("listByNamespace returns only the matching scope+owner+namespace, key-ordered", async () => {
    await repo.upsert(entry({ namespace: "prefs", key: "b", value: 2 }));
    await repo.upsert(entry({ namespace: "prefs", key: "a", value: 1 }));
    await repo.upsert(entry({ namespace: "other", key: "c", value: 3 }));
    await repo.upsert(entry({ scope: "agent", ownerId: USER, namespace: "prefs", key: "z" }));
    const list = await repo.listByNamespace("user", USER, "prefs");
    expect(list.map((e) => e.key)).toEqual(["a", "b"]);
  });
});
