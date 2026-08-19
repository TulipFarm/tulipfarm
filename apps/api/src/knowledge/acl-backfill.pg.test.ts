/**
 * Pages authored before the gate existed carry no ACL entries, and a default-deny gate would make
 * the entire existing corpus unreadable the moment it is consulted. Migration 71 backfills the same
 * blanket grant a new Page now gets on write.
 *
 * The second test is the one that matters: the backfill must not republish a Page that someone
 * deliberately restricted, because restriction is an allowlist that *replaced* the blanket grant.
 */

import type { PGlite } from "@electric-sql/pglite";
import { PgKnowledgeAclRepo } from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PG_MIGRATIONS } from "../pg-migrations";
import { makeMigratedPglite } from "../test/pglite";

const BUSINESS = "tulipfarm-local";
const SPACE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OLD = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const RESTRICTED = "cccccccc-3333-4333-8333-cccccccccccc";

/** Migration 71 is idempotent, so replaying it against a migrated database is a fair rehearsal. */
async function replayBackfill(db: PGlite): Promise<void> {
  const migration = PG_MIGRATIONS.find((m) => m.version === 71);
  if (!migration) throw new Error("migration 71 not found");
  await migration.up({
    query: async <Row = Record<string, unknown>>(text: string, params?: readonly unknown[]) =>
      db.query<Row>(text, params === undefined ? undefined : [...params]),
  });
}

describe("backfilling the blanket grant onto pre-existing Pages", () => {
  let db: PGlite;
  let acl: PgKnowledgeAclRepo;

  async function page(id: string, path: string): Promise<void> {
    await db.query(
      `INSERT INTO knowledge_pages
         (id, title, content, plain_text, source, source_id, tags, created_at, updated_at, space_id, path)
       VALUES ($1, $2, 'c', 'c', 'authored', $2, '{}', now(), now(), $3, $4)`,
      [id, path, SPACE, path]
    );
  }

  async function principalsOn(pageId: string): Promise<string[]> {
    const entries = await acl.listForSubject(BUSINESS, "page", pageId);
    return entries.map((e) => `${e.principal.kind}:${e.principal.id}`).sort();
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    acl = new PgKnowledgeAclRepo(db);
    await db.query(
      `INSERT INTO knowledge_spaces (id, name, created_at, updated_at)
       VALUES ($1, 'ops', now(), now()) ON CONFLICT DO NOTHING`,
      [SPACE]
    );
  });

  afterEach(async () => {
    await db.close();
  });

  it("gives a Page with no entries the blanket read grant", async () => {
    await page(OLD, "handbook");
    await replayBackfill(db);
    expect(await principalsOn(OLD)).toEqual(["role:role-everyone"]);
  });

  it("leaves a restricted Page restricted rather than republishing it", async () => {
    await page(RESTRICTED, "salaries");
    await acl.put({
      businessId: BUSINESS,
      subjectKind: "page",
      subjectId: RESTRICTED,
      principal: { kind: "user", id: "alice" },
      effect: "grant",
      capability: "read",
    });

    await replayBackfill(db);

    expect(await principalsOn(RESTRICTED)).toEqual(["user:alice"]);
  });

  it("is idempotent across repeated runs", async () => {
    await page(OLD, "handbook");
    await replayBackfill(db);
    await replayBackfill(db);
    expect(await principalsOn(OLD)).toEqual(["role:role-everyone"]);
  });

  it("grants read, not write", async () => {
    await page(OLD, "handbook");
    await replayBackfill(db);
    const entries = await acl.listForSubject(BUSINESS, "page", OLD);
    expect(entries.map((e) => [e.effect, e.capability])).toEqual([["grant", "read"]]);
  });
});
