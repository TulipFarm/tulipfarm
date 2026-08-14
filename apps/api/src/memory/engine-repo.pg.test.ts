import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import type { MemoryAssertionView } from "./assertion-view";
import { EngineMemoryRepo } from "./engine-repo";
import { MemoryService } from "./service";

/** M1 cutover contract: legacy KV behavior unchanged; engine adds versions and tombstones. */

const USER = "44444444-4444-4444-4444-444444444444";
const OTHER = "55555555-5555-5555-5555-555555555555";

function entry(overrides: Partial<MemoryAssertionView> = {}): MemoryAssertionView {
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

describe("EngineMemoryRepo", () => {
  let db: PGlite;
  let repo: EngineMemoryRepo;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new EngineMemoryRepo(db);
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

  it("scopes entries to their owner", async () => {
    await repo.upsert(entry({ key: "k", value: "mine" }));
    await repo.upsert(entry({ userId: OTHER, key: "k", value: "theirs" }));
    expect((await repo.listByUser(USER)).map((e) => e.value)).toEqual(["mine"]);
    expect((await repo.listByUser(OTHER)).map((e) => e.value)).toEqual(["theirs"]);
  });

  it("a re-created key after delete reads back as present", async () => {
    await repo.upsert(entry({ key: "k", value: "first" }));
    await repo.deleteByKey(USER, "k");
    await repo.upsert(entry({ key: "k", value: "second" }));
    const list = await repo.listByUser(USER);
    expect(list).toHaveLength(1);
    expect(list[0].value).toBe("second");
  });

  describe("underneath the KV surface", () => {
    it("an edit supersedes the prior version instead of overwriting it", async () => {
      await repo.upsert(entry({ key: "k", value: "old" }));
      await repo.upsert(entry({ key: "k", value: "new" }));

      const { rows } = await db.query<{
        assertion_id: string;
        statement: string;
        status: string;
        version: number;
        supersedes_id: string | null;
        superseded_by_id: string | null;
        recorded_until: Date | null;
      }>(
        `SELECT assertion_id, statement, status, version, supersedes_id, superseded_by_id, recorded_until
         FROM memory_assertions WHERE subject = 'k' ORDER BY version`
      );

      expect(rows).toHaveLength(2);
      // The prior value is still readable, and its transaction-time interval is closed.
      expect(rows[0].statement).toBe("old");
      expect(rows[0].status).toBe("superseded");
      expect(rows[0].recorded_until).not.toBeNull();
      // The new value is version 2, and the two rows point at each other.
      expect(rows[1].statement).toBe("new");
      expect(rows[1].status).toBe("active");
      expect(rows[1].version).toBe(2);
      expect(rows[1].supersedes_id).toBe(rows[0].assertion_id);
      expect(rows[0].superseded_by_id).toBe(rows[1].assertion_id);
    });

    it("a delete tombstones rather than dropping the row, and clears the statement", async () => {
      await repo.upsert(entry({ key: "k", value: "secret" }));
      await repo.deleteByKey(USER, "k");

      const { rows } = await db.query<{ statement: string; status: string }>(
        "SELECT statement, status FROM memory_assertions WHERE subject = 'k'"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("forgotten");
      // Forgetting must not leave the text behind.
      expect(rows[0].statement).toBe("");
    });

    it("writes land as confirmed user_stated preferences, never pending", async () => {
      await repo.upsert(entry({ key: "k" }));
      const { rows } = await db.query<{
        scope: string;
        memory_type: string;
        trust_tier: string;
        confirmation: string;
        origin: string;
      }>("SELECT scope, memory_type, trust_tier, confirmation, origin FROM memory_assertions");
      expect(rows[0]).toMatchObject({
        scope: "user_private",
        memory_type: "preference",
        trust_tier: "user_stated",
        confirmation: "confirmed",
        origin: "explicit",
      });
      const pending = await db.query("SELECT 1 FROM memory_pending");
      expect(pending.rows).toHaveLength(0);
    });
  });

  describe("through MemoryService", () => {
    it("still enforces the dual cap by evicting oldest-written entries", async () => {
      const service = new MemoryService(repo);
      // MAX_TOTAL_CHARS is the binding cap here: 100 entries x 256 chars.
      const value = "x".repeat(256);
      for (let i = 0; i < 105; i++) {
        await service.update(USER, `key-${String(i).padStart(3, "0")}`, value);
      }
      const list = await service.list(USER);
      expect(list.length).toBeLessThanOrEqual(100);
      // Eviction takes the oldest writes, so the most recent key must survive.
      expect(list.some((e) => e.key === "key-104")).toBe(true);
      expect(list.some((e) => e.key === "key-000")).toBe(false);
    });

    it("still rejects an oversize value without writing anything", async () => {
      const service = new MemoryService(repo);
      const outcome = await service.update(USER, "k", "x".repeat(257));
      expect(outcome.kind).toBe("rejected_oversize");
      expect(await service.list(USER)).toHaveLength(0);
    });
  });
});
