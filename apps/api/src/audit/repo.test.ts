import { PGlite } from "@electric-sql/pglite";
import {
  AuditAppendConflictError,
  type AuditEventInput,
  AuditWriter,
  verifyChain,
} from "@tulipfarm/audit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import { PG_MIGRATIONS } from "../pg-migrations";
import { PgAuditEventRepo } from "./repo";

const BUSINESS = "biz-1";

function input(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    actor: { principalId: "user-1", businessId: BUSINESS },
    effectivePrincipal: { principalId: "agent-1", businessId: BUSINESS },
    action: "tool.invoke",
    target: "github:create_issue",
    decision: "allow",
    reasonCodes: ["POLICY_OK"],
    correlationId: "corr-1",
    occurredAt: new Date("2024-05-01T10:00:00.000Z"),
    ...overrides,
  };
}

describe("PgAuditEventRepo", () => {
  let pg: PGlite;
  let db: Queryable;
  let repo: PgAuditEventRepo;
  let writer: AuditWriter;

  beforeEach(async () => {
    pg = new PGlite();
    db = { query: (text, params) => pg.query(text, params as never[]) as never };
    // Run only the audit migration: this suite is about the ledger, not the whole schema.
    const migration = PG_MIGRATIONS.find((m) => m.version === 46);
    if (!migration) throw new Error("audit migration v46 is missing");
    await migration.up(db);
    repo = new PgAuditEventRepo(db);
    writer = new AuditWriter(repo);
  });

  afterEach(async () => {
    await pg.close();
  });

  describe("round-trip", () => {
    it("returns an empty chain before anything is appended", async () => {
      expect(await repo.getLatest(BUSINESS)).toBeUndefined();
      expect(await repo.listChain(BUSINESS)).toEqual([]);
    });

    it("preserves every field through a write and read", async () => {
      const written = await writer.append(
        input({
          agentId: "a-1",
          runId: "r-1",
          stateId: "s-1",
          guardrailDigest: "gd",
          bundleDigest: "bd",
          sourceClassification: "internal",
          destinationClassification: "public",
          requestHash: "rq",
          resultHash: "rs",
          causationId: "cause-1",
          safeMetadata: { tool: "github", attempt: 2, dryRun: false },
          safeRefs: [{ key: "blob/1", hash: "h1" }],
        })
      );

      const [stored] = await repo.listChain(BUSINESS);
      expect(stored).toEqual(written);
    });

    it("omits absent optional fields rather than storing them as undefined", async () => {
      await writer.append(input());
      const [stored] = await repo.listChain(BUSINESS);

      expect(stored).toBeDefined();
      expect("agentId" in (stored as object)).toBe(false);
      expect("safeMetadata" in (stored as object)).toBe(false);
    });
  });

  describe("chain integrity", () => {
    it("links successive events and verifies as an unbroken chain", async () => {
      for (let i = 0; i < 5; i += 1) {
        await writer.append(input({ correlationId: `corr-${i}` }));
      }

      const chain = await repo.listChain(BUSINESS);
      expect(chain.map((e) => e.chainIndex)).toEqual([0, 1, 2, 3, 4]);
      expect(chain[0]?.previousHash).toBeNull();
      expect(chain[1]?.previousHash).toBe(chain[0]?.hash);
      // The package's own verifier is the real assertion — it is what an auditor would run.
      expect(verifyChain(chain).issues).toEqual([]);
    });

    it("keeps chains for different businesses independent", async () => {
      const other = "biz-2";
      await writer.append(input());
      await writer.append(
        input({
          actor: { principalId: "user-2", businessId: other },
          effectivePrincipal: { principalId: "agent-2", businessId: other },
        })
      );

      expect((await repo.getLatest(BUSINESS))?.chainIndex).toBe(0);
      expect((await repo.getLatest(other))?.chainIndex).toBe(0);
    });

    it("rejects an event whose hash does not match its contents", async () => {
      const real = await writer.append(input());
      const forged = { ...real, chainIndex: 1, previousHash: real.hash, target: "somewhere-else" };

      await expect(repo.append(forged)).rejects.toBeInstanceOf(AuditAppendConflictError);
      expect(await repo.listChain(BUSINESS)).toHaveLength(1);
    });
  });

  describe("compare-and-append", () => {
    it("rejects an event that does not extend the current tail", async () => {
      const first = await writer.append(input());
      // A well-formed event, correctly hashed, but built against a tail that has moved on.
      const stale = await new AuditWriter(new PgAuditEventRepo(db)).append(input());
      expect(stale.chainIndex).toBe(1);

      await expect(repo.append({ ...first, id: crypto.randomUUID() })).rejects.toBeInstanceOf(
        AuditAppendConflictError
      );
    });

    it("lets AuditWriter resolve a race so concurrent appends all land exactly once", async () => {
      // Every writer reads the same empty tail, so all but one must lose and retry.
      const writers = Array.from({ length: 8 }, () => new AuditWriter(new PgAuditEventRepo(db)));
      await Promise.all(writers.map((w, i) => w.append(input({ correlationId: `race-${i}` }))));

      const chain = await repo.listChain(BUSINESS);
      expect(chain).toHaveLength(8);
      expect(chain.map((e) => e.chainIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(verifyChain(chain).issues).toEqual([]);
    });
  });

  describe("database-enforced immutability", () => {
    it("refuses UPDATE, DELETE and TRUNCATE even outside the repository", async () => {
      // Not a test of the adapter but of the guarantee beneath it: the ledger must survive code
      // that never goes through `PgAuditEventRepo` at all.
      await writer.append(input());

      await expect(db.query("UPDATE audit_events SET target = 'tampered'")).rejects.toThrow(
        /append-only/
      );
      await expect(db.query("DELETE FROM audit_events")).rejects.toThrow(/append-only/);
      await expect(db.query("TRUNCATE audit_events")).rejects.toThrow(/append-only/);

      const chain = await repo.listChain(BUSINESS);
      expect(chain).toHaveLength(1);
      expect(chain[0]?.target).toBe("github:create_issue");
    });

    it("still allows INSERT, so blocking mutation does not block auditing", async () => {
      await expect(writer.append(input())).resolves.toBeDefined();
    });
  });

  it("keeps the caller's transaction usable when a chain conflict happens inside one", async () => {
    // A unique violation aborts the *whole* enclosing transaction, not just the failed statement.
    // Without a savepoint the AuditWriter's retry reads back 25P02 and the caller's business
    // transaction dies with it — so a conflict must roll back only the audit insert.
    const calls: string[] = [];
    let failNext = true;
    const flaky: Queryable = {
      query: async (text: string, params?: unknown[]) => {
        calls.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
        if (text.includes("INSERT INTO audit_events") && failNext) {
          failNext = false;
          throw Object.assign(new Error("duplicate key"), { code: "23505" });
        }
        return db.query(text, params);
      },
    };

    await db.query("BEGIN");
    // The retry has to survive the conflict and land, which it can only do if the transaction is
    // still alive afterwards.
    const event = await new AuditWriter(new PgAuditEventRepo(flaky, true)).append(input());
    await db.query("COMMIT");

    expect(calls).toContain("SAVEPOINT audit_append");
    expect(calls).toContain("ROLLBACK TO SAVEPOINT");
    const chain = await repo.listChain(BUSINESS);
    expect(chain.map((e) => e.hash)).toEqual([event.hash]);
  });

  it("issues no savepoint when it is not inside a transaction", async () => {
    // Outside a transaction SAVEPOINT is a hard error, so it must not be emitted there.
    const calls: string[] = [];
    const spy: Queryable = {
      query: async (text: string, params?: unknown[]) => {
        calls.push(text);
        return db.query(text, params);
      },
    };

    await new AuditWriter(new PgAuditEventRepo(spy)).append(input());

    expect(calls.some((c) => c.includes("SAVEPOINT"))).toBe(false);
  });
});
