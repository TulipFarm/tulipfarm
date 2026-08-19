/**
 * Inheritance of Knowledge ACL entries down the Page tree.
 *
 * The gate allows on any matching grant, so merging an ancestor's entries with a descendant's as a
 * flat union can only ever *widen*: a Space restricted to one person, with a child Page granting a
 * second, would permit both. Under allowlist restriction that is a re-open, and it makes every
 * restriction defeatable from the inside. These tests pin the narrowing rule instead.
 */

import type { PGlite } from "@electric-sql/pglite";
import {
  BLANKET_READ_PRINCIPAL,
  PgKnowledgeAclRepo,
  PgKnowledgeSubjectStore,
} from "@tulipfarm/knowledge";
import type { Queryable } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

const BUSINESS = "tulipfarm-local";
const SPACE = "55555555-5555-5555-5555-555555555555";
const HANDBOOK = "66666666-6666-6666-6666-666666666666";
const PAY = "77777777-7777-7777-7777-777777777777";
const BANDS = "88888888-8888-8888-8888-888888888888";
const NOW = new Date("2026-08-18T12:00:00.000Z");

const alice = { kind: "user", id: "alice" };
const bob = { kind: "user", id: "bob" };
const carol = { kind: "user", id: "carol" };

/** Counts queries so a listing can be shown not to scale its query count with the corpus. */
function counting(db: PGlite): { readonly q: Queryable; readonly count: () => number } {
  let n = 0;
  return {
    q: {
      query: async <Row = Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
        n += 1;
        return db.query<Row>(text, params === undefined ? undefined : [...params]);
      },
    },
    count: () => n,
  };
}

describe("knowledge ACL inheritance", () => {
  let db: PGlite;
  let acl: PgKnowledgeAclRepo;
  let subjects: PgKnowledgeSubjectStore;

  async function page(id: string, path: string): Promise<void> {
    await db.query(
      `INSERT INTO knowledge_pages
         (id, title, content, plain_text, source, source_id, tags, created_at, updated_at, space_id, path)
       VALUES ($1, $2, 'c', 'c', 'authored', $2, '{}', now(), now(), $3, $4)`,
      [id, path, SPACE, path]
    );
  }

  async function grant(
    subjectKind: "space" | "page",
    subjectId: string,
    principal: { kind: string; id: string }
  ): Promise<void> {
    await acl.put({
      businessId: BUSINESS,
      subjectKind,
      subjectId,
      principal,
      effect: "grant",
      capability: "read",
    });
  }

  /** The Principals a subject actually grants read to, which is what the gate consults. */
  async function grantedTo(pageId: string): Promise<string[]> {
    const subject = await subjects.getAuthored(BUSINESS, pageId);
    return (subject?.entries ?? [])
      .filter((e) => e.effect === "grant")
      .map((e) => e.principal.id)
      .sort();
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    acl = new PgKnowledgeAclRepo(db);
    subjects = new PgKnowledgeSubjectStore(db, () => NOW);
    await db.query(
      `INSERT INTO knowledge_spaces (id, name, description, created_at, updated_at)
       VALUES ($1, 'Board', null, now(), now())`,
      [SPACE]
    );
    await page(HANDBOOK, "/handbook");
    await page(PAY, "/handbook/pay");
    await page(BANDS, "/handbook/pay/bands");
  });

  afterEach(async () => {
    await db.close();
  });

  it("leaves a Page with no restricted ancestor exactly as it was", async () => {
    await grant("page", BANDS, alice);
    expect(await grantedTo(BANDS)).toEqual(["alice"]);
  });

  it("treats a Page with no entries of its own as inheriting, not as granting nobody", async () => {
    await grant("page", HANDBOOK, alice);
    expect(await grantedTo(PAY)).toEqual(["alice"]);
  });

  it("inherits the permitted Principals of a restricted parent Page", async () => {
    await grant("page", PAY, alice);
    expect(await grantedTo(BANDS)).toEqual(["alice"]);
  });

  it("inherits from the nearest restricted ancestor rather than the root", async () => {
    await grant("page", HANDBOOK, alice);
    await grant("page", HANDBOOK, bob);
    await grant("page", PAY, alice);
    expect(await grantedTo(BANDS)).toEqual(["alice"]);
  });

  it("falls back to the Space when no ancestor Page is restricted", async () => {
    await grant("space", SPACE, carol);
    expect(await grantedTo(BANDS)).toEqual(["carol"]);
  });

  /**
   * Every authored Page carries the blanket "everyone in this Business" grant until someone
   * restricts it, so an *open* ancestor Page is the common case, not an edge one. It must not
   * become the baseline the descendant is intersected against: `{everyone}` ∩ `{alice}` is empty,
   * and the Page ends up readable by nobody at all — including Alice, and including its author.
   */
  describe("an open ancestor", () => {
    const everyone = BLANKET_READ_PRINCIPAL;

    it("does not narrow a restricted descendant to nobody", async () => {
      await grant("page", HANDBOOK, everyone);
      await grant("page", PAY, alice);
      expect(await grantedTo(PAY)).toEqual(["alice"]);
    });

    it("does not narrow across several open levels", async () => {
      await grant("space", SPACE, everyone);
      await grant("page", HANDBOOK, everyone);
      await grant("page", PAY, everyone);
      await grant("page", BANDS, alice);
      expect(await grantedTo(BANDS)).toEqual(["alice"]);
    });

    it("still leaves an unrestricted chain readable Business-wide", async () => {
      await grant("page", HANDBOOK, everyone);
      await grant("page", PAY, everyone);
      expect(await grantedTo(PAY)).toEqual([everyone.id]);
    });

    it("does not re-open a restricted ancestor", async () => {
      await grant("page", HANDBOOK, alice);
      await grant("page", PAY, everyone);
      await grant("page", BANDS, everyone);
      expect(await grantedTo(BANDS)).toEqual(["alice"]);
    });

    it("does not stop a genuinely restricted ancestor from narrowing", async () => {
      await grant("page", HANDBOOK, everyone);
      await grant("page", PAY, alice);
      await grant("page", BANDS, bob);
      expect(await grantedTo(BANDS)).toEqual([]);
    });
  });

  it("drops a descendant's grant naming a Principal its nearest restricted ancestor excludes", async () => {
    await grant("page", PAY, alice);
    await grant("page", BANDS, bob);
    expect(await grantedTo(BANDS)).toEqual([]);
  });

  it("drops a descendant's grant that the Space excludes", async () => {
    await grant("space", SPACE, alice);
    await grant("page", BANDS, bob);
    expect(await grantedTo(BANDS)).toEqual([]);
  });

  it("keeps a descendant's narrowing to a subset of its ancestor's Principals", async () => {
    await grant("page", PAY, alice);
    await grant("page", PAY, bob);
    await grant("page", BANDS, alice);
    expect(await grantedTo(BANDS)).toEqual(["alice"]);
  });

  it("narrows cumulatively down a chain, so a mid-level grant cannot re-widen", async () => {
    await grant("space", SPACE, alice);
    await grant("space", SPACE, bob);
    await grant("page", HANDBOOK, alice);
    await grant("page", PAY, alice);
    await grant("page", PAY, bob);
    expect(await grantedTo(PAY)).toEqual(["alice"]);
  });

  it("applies a deny from any ancestor regardless of narrowing", async () => {
    await grant("space", SPACE, alice);
    await acl.put({
      businessId: BUSINESS,
      subjectKind: "page",
      subjectId: HANDBOOK,
      principal: alice,
      effect: "deny",
      capability: "read",
    });
    const subject = await subjects.getAuthored(BUSINESS, BANDS);
    expect(subject?.entries.some((e) => e.effect === "deny" && e.principal.id === "alice")).toBe(
      true
    );
  });

  it("resolves a listing without issuing queries per Page", async () => {
    await grant("space", SPACE, alice);
    const probe = counting(db);
    const store = new PgKnowledgeSubjectStore(probe.q, () => NOW);
    const listed = await store.listAuthored(BUSINESS);
    expect(listed).toHaveLength(3);
    expect(probe.count()).toBeLessThanOrEqual(3);
  });

  it("resolves a listing to the same entries as fetching each Page individually", async () => {
    await grant("page", PAY, alice);
    await grant("page", BANDS, bob);
    const listed = await subjects.listAuthored(BUSINESS);
    for (const subject of listed) {
      const single = await subjects.getAuthored(BUSINESS, subject.subjectId);
      expect(single?.entries).toEqual(subject.entries);
    }
  });
});
