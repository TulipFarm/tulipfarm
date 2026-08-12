import { PGlite } from "@electric-sql/pglite";
import { type AuditEventInput, AuditWriter } from "@tulipfarm/audit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import { PG_MIGRATIONS } from "../pg-migrations";
import { AuditReadService, AuditTooLargeError, VERIFY_MAX_EVENTS } from "./read-service";
import { AUDIT_PAGE_MAX, PgAuditEventRepo } from "./repo";

const BUSINESS = "biz-1";
const OTHER_BUSINESS = "biz-2";

function input(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    actor: { principalId: "user-1", businessId: BUSINESS },
    effectivePrincipal: { principalId: "user-1", businessId: BUSINESS },
    action: "skill.install",
    target: "skill:acme/deploy",
    decision: "allow",
    reasonCodes: ["SOUL_DIRECT_WRITE"],
    correlationId: "corr-1",
    occurredAt: new Date("2024-05-01T10:00:00.000Z"),
    ...overrides,
  };
}

describe("audit read path", () => {
  let pg: PGlite;
  let db: Queryable;
  let repo: PgAuditEventRepo;
  let writer: AuditWriter;
  let service: AuditReadService;

  beforeAll(async () => {
    pg = new PGlite();
    db = { query: (text, params) => pg.query(text, params as never[]) as never };
    const migration = PG_MIGRATIONS.find((m) => m.version === 46);
    if (!migration) throw new Error("audit migration v46 is missing");
    await migration.up(db);
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    // The table blocks DELETE and TRUNCATE by trigger — which is the point of the ledger — so a
    // clean slate needs the trigger stood down for the length of the reset.
    await db.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_mutate");
    await db.query("DELETE FROM audit_events");
    await db.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_mutate");
    repo = new PgAuditEventRepo(db);
    writer = new AuditWriter(repo);
    service = new AuditReadService(repo, BUSINESS);
  });

  async function seed(
    count: number,
    overrides: (i: number) => Partial<AuditEventInput> = () => ({})
  ) {
    for (let i = 0; i < count; i++) {
      await writer.append(input({ correlationId: `corr-${i}`, ...overrides(i) }));
    }
  }

  describe("listPage", () => {
    it("returns an empty page when nothing has been recorded", async () => {
      expect(await service.list()).toEqual({ items: [], nextCursor: null });
    });

    it("returns newest first", async () => {
      await seed(3);
      const page = await service.list();
      expect(page.items.map((e) => e.chainIndex)).toEqual([2, 1, 0]);
    });

    it("pages through the whole chain without skipping or repeating a row", async () => {
      await seed(7);

      const seen: number[] = [];
      let cursor: number | null | undefined;
      // Bounded so a cursor bug loops finitely and fails on the assertion, not by hanging.
      for (let guard = 0; guard < 10; guard++) {
        const page = await service.list({
          limit: 3,
          ...(cursor === null || cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.items.map((e) => e.chainIndex));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }

      expect(seen).toEqual([6, 5, 4, 3, 2, 1, 0]);
      expect(cursor).toBeNull();
    });

    it("reports no next cursor when the last page is exactly full", async () => {
      // The overfetch-by-one boundary: 4 rows read with limit 2 must not claim a third page.
      await seed(4);
      const first = await service.list({ limit: 2 });
      expect(first.nextCursor).toBe(2);
      const second = await service.list({ limit: 2, cursor: first.nextCursor as number });
      expect(second.items.map((e) => e.chainIndex)).toEqual([1, 0]);
      expect(second.nextCursor).toBeNull();
    });

    it("caps an oversized limit rather than scanning the whole ledger", async () => {
      await seed(3);
      const page = await service.list({ limit: 10_000 });
      expect(page.items).toHaveLength(3);
      expect(AUDIT_PAGE_MAX).toBeLessThan(10_000);
    });

    it("filters by action, actor and decision", async () => {
      await seed(1);
      await writer.append(input({ action: "integration.connect", correlationId: "c-a" }));
      await writer.append(
        input({
          actor: { principalId: "user-2", businessId: BUSINESS },
          effectivePrincipal: { principalId: "user-2", businessId: BUSINESS },
          correlationId: "c-b",
        })
      );
      await writer.append(input({ decision: "deny", correlationId: "c-c" }));

      expect((await service.list({ action: "integration.connect" })).items).toHaveLength(1);
      expect((await service.list({ actorId: "user-2" })).items).toHaveLength(1);
      expect((await service.list({ decision: "deny" })).items).toHaveLength(1);
    });

    it("never returns another business's events", async () => {
      await seed(2);
      const otherRepo = new PgAuditEventRepo(db);
      await new AuditWriter(otherRepo).append({
        ...input(),
        actor: { principalId: "user-9", businessId: OTHER_BUSINESS },
        effectivePrincipal: { principalId: "user-9", businessId: OTHER_BUSINESS },
        correlationId: "other",
      });

      const page = await service.list();
      expect(page.items).toHaveLength(2);
      expect(page.items.every((e) => e.businessId === BUSINESS)).toBe(true);
    });
  });

  describe("verify", () => {
    it("reports a clean chain", async () => {
      await seed(3);
      const report = await service.verify();
      expect(report.valid).toBe(true);
      expect(report.issues).toEqual([]);
      expect(report.eventCount).toBe(3);
      expect(report.tailHash).toEqual(expect.any(String));
    });

    it("is clean and empty for a ledger with no events", async () => {
      const report = await service.verify();
      expect(report.valid).toBe(true);
      expect(report.eventCount).toBe(0);
      expect(report.tailHash).toBeNull();
    });

    it("detects a tampered event", async () => {
      await seed(3);
      // Reach past the append-only trigger the way an attacker with database access would.
      await db.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_mutate");
      await db.query("UPDATE audit_events SET target = $1 WHERE chain_index = 1", ["skill:evil"]);
      await db.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_mutate");

      const report = await service.verify();
      expect(report.valid).toBe(false);
      expect(report.issues.map((i) => i.type)).toContain("tampered");
    });

    it("detects a deleted middle event", async () => {
      await seed(3);
      await db.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_mutate");
      await db.query("DELETE FROM audit_events WHERE chain_index = 1");
      await db.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_mutate");

      const report = await service.verify();
      expect(report.valid).toBe(false);
      expect(report.issues.map((i) => i.type)).toContain("missing");
    });

    it("cannot detect tail deletion without an anchor, and can with one", async () => {
      await seed(3);
      const pinned = await service.verify();

      await db.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_mutate");
      await db.query("DELETE FROM audit_events WHERE chain_index = 2");
      await db.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_mutate");

      // Every remaining hash still links correctly, so the ledger alone cannot testify to its
      // own former length. This is the documented limitation, asserted so it stays honest.
      expect((await service.verify()).valid).toBe(true);

      const anchored = await service.verify({
        eventCount: pinned.eventCount,
        tailHash: pinned.tailHash,
      });
      expect(anchored.valid).toBe(false);
    });

    it("refuses to verify a chain above the ceiling instead of pinning a connection", async () => {
      const huge = {
        count: async () => VERIFY_MAX_EVENTS + 1,
        listChain: async () => {
          throw new Error("listChain must not be reached above the ceiling");
        },
        listPage: async () => ({ items: [], nextCursor: null }),
      };
      await expect(new AuditReadService(huge, BUSINESS).verify()).rejects.toBeInstanceOf(
        AuditTooLargeError
      );
    });
  });
});
