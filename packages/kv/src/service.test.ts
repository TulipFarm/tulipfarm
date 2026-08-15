import { describe, expect, it } from "vitest";
import { assertValidAssertion, type KvEntry, type KvRepo, type KvScope } from "./repo";
import { KvService } from "./service";

/** Owner key as the DB stores it: '' for system, the ownerId otherwise. Mirrors `owner_id`. */
function ownerKey(scope: KvScope, ownerId: string | undefined): string {
  return scope === "system" ? "" : (ownerId ?? "");
}

/** In-memory repo mirroring PgKvRepo semantics: composite identity, lazy expiry, created_at preserved. */
class FakeKvRepo implements KvRepo {
  rows: KvEntry[] = [];

  private idx(
    scope: KvScope,
    ownerId: string | undefined,
    namespace: string,
    key?: string
  ): number {
    return this.rows.findIndex(
      (e) =>
        e.scope === scope &&
        ownerKey(e.scope, e.ownerId) === ownerKey(scope, ownerId) &&
        e.namespace === namespace &&
        (key === undefined || e.key === key)
    );
  }

  private live(e: KvEntry): boolean {
    return !e.expiresAt || e.expiresAt.getTime() > Date.now();
  }

  async upsert(doc: KvEntry): Promise<void> {
    assertValidAssertion(doc);
    const normalized: KvEntry = {
      ...doc,
      ownerId: doc.scope === "system" ? undefined : doc.ownerId,
    };
    const i = this.idx(normalized.scope, normalized.ownerId, normalized.namespace, normalized.key);
    if (i >= 0) {
      // Last-write-wins; created_at is preserved (only value/expiry/updated_at change).
      this.rows[i] = {
        ...this.rows[i],
        value: normalized.value,
        expiresAt: normalized.expiresAt,
        updatedAt: normalized.updatedAt,
      };
    } else {
      this.rows.push({ ...normalized });
    }
  }

  async get(
    scope: KvScope,
    ownerId: string | undefined,
    namespace: string,
    key: string
  ): Promise<KvEntry | null> {
    const i = this.idx(scope, ownerId, namespace, key);
    return i >= 0 && this.live(this.rows[i]) ? { ...this.rows[i] } : null;
  }

  async delete(
    scope: KvScope,
    ownerId: string | undefined,
    namespace: string,
    key: string
  ): Promise<boolean> {
    const i = this.idx(scope, ownerId, namespace, key);
    if (i < 0 || !this.live(this.rows[i])) return false;
    this.rows.splice(i, 1);
    return true;
  }

  async listByNamespace(
    scope: KvScope,
    ownerId: string | undefined,
    namespace: string
  ): Promise<KvEntry[]> {
    return this.rows
      .filter(
        (e) =>
          e.scope === scope &&
          ownerKey(e.scope, e.ownerId) === ownerKey(scope, ownerId) &&
          e.namespace === namespace &&
          this.live(e)
      )
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((e) => ({ ...e }));
  }
}

const U = "u1";

describe("KvService.set", () => {
  it("stores a value and reads it back", async () => {
    const svc = new KvService(new FakeKvRepo());
    await expect(svc.set("user", U, "prefs", "theme", { mode: "dark" })).resolves.toEqual({
      kind: "ok",
    });
    expect((await svc.get("user", U, "prefs", "theme"))?.value).toEqual({ mode: "dark" });
  });

  it("preserves created_at across an update (last-write-wins)", async () => {
    const svc = new KvService(new FakeKvRepo());
    await svc.set("user", U, "prefs", "theme", "a");
    const first = await svc.get("user", U, "prefs", "theme");
    await new Promise((r) => setTimeout(r, 3));
    await svc.set("user", U, "prefs", "theme", "b");
    const second = await svc.get("user", U, "prefs", "theme");
    expect(second?.value).toBe("b");
    expect(second?.createdAt.getTime()).toBe(first?.createdAt.getTime());
    expect((second?.updatedAt.getTime() ?? 0) >= (first?.updatedAt.getTime() ?? 0)).toBe(true);
  });

  it("rejects an oversize value (by bytes) and writes nothing", async () => {
    const repo = new FakeKvRepo();
    const svc = new KvService(repo);
    const big = "x".repeat(256 * 1024 + 50);
    const outcome = await svc.set("user", U, "n", "k", big);
    expect(outcome.kind).toBe("rejected_oversize");
    expect(repo.rows).toHaveLength(0);
  });

  it("measures the cap in UTF-8 bytes, not characters (multibyte over byte-cap, under char count)", async () => {
    const svc = new KvService(new FakeKvRepo());
    // 200k 'é' = 200k chars (< 262144) but ~400k UTF-8 bytes (> 262144) → must be rejected.
    const outcome = await svc.set("user", U, "n", "k", "é".repeat(200_000));
    expect(outcome.kind).toBe("rejected_oversize");
  });

  it("rejects invalid namespace/key charset and over-length names", async () => {
    const svc = new KvService(new FakeKvRepo());
    expect((await svc.set("user", U, "bad space", "k", 1)).kind).toBe("rejected_invalid");
    expect((await svc.set("user", U, "n", "has/slash", 1)).kind).toBe("rejected_invalid");
    expect((await svc.set("user", U, "x".repeat(129), "k", 1)).kind).toBe("rejected_invalid");
    expect((await svc.set("user", U, "n", "x".repeat(257), 1)).kind).toBe("rejected_invalid");
  });

  it("accepts a system entry with no owner, but a user entry requires one", async () => {
    const svc = new KvService(new FakeKvRepo());
    await expect(svc.set("system", undefined, "cfg", "salt", "s")).resolves.toEqual({ kind: "ok" });
    await expect(svc.set("user", undefined, "cfg", "salt", "s")).rejects.toThrow();
  });

  it("honors expiry passed through to the store (lazy)", async () => {
    const svc = new KvService(new FakeKvRepo());
    await svc.set("user", U, "n", "live", 1, new Date(Date.now() + 60_000));
    await svc.set("user", U, "n", "dead", 1, new Date(Date.now() - 60_000));
    expect(await svc.get("user", U, "n", "live")).not.toBeNull();
    expect(await svc.get("user", U, "n", "dead")).toBeNull();
  });
});

describe("KvService.delete", () => {
  it("is idempotent: true then false", async () => {
    const svc = new KvService(new FakeKvRepo());
    await svc.set("user", U, "n", "k", 1);
    await expect(svc.delete("user", U, "n", "k")).resolves.toBe(true);
    await expect(svc.delete("user", U, "n", "k")).resolves.toBe(false);
  });
});
