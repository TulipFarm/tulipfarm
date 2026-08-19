/** Proves the unified Knowledge ACL schema is default-deny and that deletion is real, not cosmetic. */

import type { PGlite } from "@electric-sql/pglite";
import { PgKnowledgeAclRepo, PgKnowledgeSubjectStore } from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

const BUSINESS = "tulipfarm-local";
const SPACE = "33333333-3333-3333-3333-333333333333";
const PAGE = "44444444-4444-4444-4444-444444444444";
const NOW = new Date("2026-08-18T12:00:00.000Z");

const alice = { kind: "user", id: "alice" };
const board = { kind: "group", id: "group-board" };

describe("knowledge ACL schema", () => {
  let db: PGlite;
  let acl: PgKnowledgeAclRepo;
  let subjects: PgKnowledgeSubjectStore;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    acl = new PgKnowledgeAclRepo(db);
    subjects = new PgKnowledgeSubjectStore(db, () => NOW);
    await db.query(
      `INSERT INTO knowledge_spaces (id, name, description, created_at, updated_at)
       VALUES ($1, 'Board', null, now(), now())`,
      [SPACE]
    );
    await db.query(
      `INSERT INTO knowledge_pages
         (id, title, content, plain_text, source, source_id, tags, created_at, updated_at, space_id, path)
       VALUES ($1, 'Minutes', 'c', 'c', 'authored', 'minutes', '{}', now(), now(), $2, '/minutes')`,
      [PAGE, SPACE]
    );
  });

  afterEach(async () => {
    await db.close();
  });

  it("gives new spaces and pages the deployment business and an initial ACL revision", async () => {
    const { rows } = await db.query<{ business_id: string; acl_revision: string }>(
      "SELECT business_id, acl_revision FROM knowledge_pages WHERE id = $1",
      [PAGE]
    );
    expect(rows[0]).toEqual({ business_id: BUSINESS, acl_revision: "1" });
  });

  it("projects a page with no entries as a subject nobody can read", async () => {
    const subject = await subjects.getAuthored(BUSINESS, PAGE);
    expect(subject?.entries).toEqual([]);
    expect(subject?.provider).toBe("tulipfarm");
  });

  it("merges the space's entries into the page that inherits them", async () => {
    await acl.put({
      businessId: BUSINESS,
      subjectKind: "space",
      subjectId: SPACE,
      principal: board,
      effect: "grant",
      capability: "read",
    });
    await acl.put({
      businessId: BUSINESS,
      subjectKind: "page",
      subjectId: PAGE,
      principal: alice,
      effect: "deny",
      capability: "read",
    });

    const subject = await subjects.getAuthored(BUSINESS, PAGE);
    expect(subject?.entries).toEqual([
      {
        subjectKind: "space",
        subjectId: SPACE,
        principal: board,
        effect: "grant",
        capability: "read",
      },
      {
        subjectKind: "page",
        subjectId: PAGE,
        principal: alice,
        effect: "deny",
        capability: "read",
      },
    ]);
  });

  it("stores a group grant as the group rather than flattening it to members", async () => {
    await acl.put({
      businessId: BUSINESS,
      subjectKind: "space",
      subjectId: SPACE,
      principal: board,
      effect: "grant",
      capability: "read",
    });
    const entries = await acl.listForSubject(BUSINESS, "space", SPACE);
    expect(entries).toEqual([
      {
        subjectKind: "space",
        subjectId: SPACE,
        principal: board,
        effect: "grant",
        capability: "read",
      },
    ]);
  });

  it("replaces a grant with a deny in place rather than keeping both", async () => {
    const base = {
      businessId: BUSINESS,
      subjectKind: "page",
      subjectId: PAGE,
      principal: alice,
      capability: "read",
    } as const;
    await acl.put({ ...base, effect: "grant" });
    await acl.put({ ...base, effect: "deny" });
    const entries = await acl.listForSubject(BUSINESS, "page", PAGE);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.effect).toBe("deny");
  });

  it("refuses an effect outside grant and deny", async () => {
    await expect(
      db.query(
        `INSERT INTO knowledge_acl_entries
           (business_id, subject_kind, subject_id, principal_kind, principal_id, effect)
         VALUES ($1, 'page', $2, 'user', 'mallory', 'maybe')`,
        [BUSINESS, PAGE]
      )
    ).rejects.toThrow();
  });

  it("drops a page's entries when the page row is deleted", async () => {
    await acl.put({
      businessId: BUSINESS,
      subjectKind: "page",
      subjectId: PAGE,
      principal: alice,
      effect: "grant",
      capability: "read",
    });
    await db.query("DELETE FROM knowledge_pages WHERE id = $1", [PAGE]);
    expect(await acl.listForSubject(BUSINESS, "page", PAGE)).toEqual([]);
  });

  it("drops a space's entries when the space row is deleted", async () => {
    await acl.put({
      businessId: BUSINESS,
      subjectKind: "space",
      subjectId: SPACE,
      principal: board,
      effect: "grant",
      capability: "read",
    });
    // `knowledge_pages.space_id` has no ON DELETE CASCADE, so the page goes first.
    await db.query("DELETE FROM knowledge_pages WHERE id = $1", [PAGE]);
    await db.query("DELETE FROM knowledge_spaces WHERE id = $1", [SPACE]);
    expect(await acl.listForSubject(BUSINESS, "space", SPACE)).toEqual([]);
  });

  it("does not return a page belonging to another business", async () => {
    expect(await subjects.getAuthored("someone-else", PAGE)).toBeUndefined();
    expect(await subjects.listAuthored("someone-else")).toEqual([]);
  });

  it("marks a deactivated page as revoked so the gate refuses it", async () => {
    await db.query("UPDATE knowledge_pages SET active = false WHERE id = $1", [PAGE]);
    const subject = await subjects.getAuthored(BUSINESS, PAGE);
    expect(subject?.status).toBe("revoked");
  });
});
