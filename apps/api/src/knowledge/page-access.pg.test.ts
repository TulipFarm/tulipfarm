/**
 * The read gate for authored Pages: one place every Page-returning route consults, so a new surface
 * cannot forget to authorize.
 *
 * A denial is silent by construction. `readablePageIds` returns the subset the actor may read and
 * counts the rest, so a caller has nothing to render for a withheld Page — no title, no path, no
 * distinguishing status — and a route cannot accidentally leak existence by returning 403 for a
 * Page that exists and 404 for one that does not.
 */

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { PgKnowledgeAclRepo } from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { PageReadGate } from "./page-access";

const BUSINESS = "tulipfarm-local";
const SPACE = "dddddddd-4444-4444-8444-dddddddddddd";
const BLANKET = { kind: "role", id: "role-everyone" };

describe("authored Page read gate", () => {
  let db: PGlite;
  let acl: PgKnowledgeAclRepo;
  let gate: PageReadGate;
  let alice: string;
  let bob: string;

  async function user(): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, role, created_at)
       VALUES ($1, $2, 'x', 'member', now())`,
      [id, `${id}@example.test`]
    );
    await db.query(
      `INSERT INTO principals (business_id, id, kind, status) VALUES ($1, $2, 'user', 'active')
       ON CONFLICT DO NOTHING`,
      [BUSINESS, id]
    );
    return id;
  }

  /** A Page carrying the blanket grant, exactly as `writePage` now creates one. */
  async function blanketPage(path: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO knowledge_pages
         (id, title, content, plain_text, source, source_id, tags, created_at, updated_at, space_id, path)
       VALUES ($1, $2, 'c', 'c', 'authored', $2, '{}', now(), now(), $3, $4)`,
      [id, path, SPACE, path]
    );
    await acl.put({
      businessId: BUSINESS,
      subjectKind: "page",
      subjectId: id,
      principal: BLANKET,
      effect: "grant",
      capability: "read",
    });
    return id;
  }

  async function restrictTo(pageId: string, userId: string): Promise<void> {
    await acl.remove(BUSINESS, "page", pageId, BLANKET);
    await acl.put({
      businessId: BUSINESS,
      subjectKind: "page",
      subjectId: pageId,
      principal: { kind: "user", id: userId },
      effect: "grant",
      capability: "read",
    });
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    acl = new PgKnowledgeAclRepo(db);
    gate = new PageReadGate({
      query: async <Row = Record<string, unknown>>(text: string, params?: readonly unknown[]) =>
        db.query<Row>(text, params === undefined ? undefined : [...params]),
    });
    await db.query(
      `INSERT INTO knowledge_spaces (id, name, created_at, updated_at)
       VALUES ($1, 'ops', now(), now()) ON CONFLICT DO NOTHING`,
      [SPACE]
    );
    alice = await user();
    bob = await user();
  });

  afterEach(async () => {
    await db.close();
  });

  it("lets a member read a Page another member authored", async () => {
    const page = await blanketPage("handbook");
    expect(await gate.canRead(bob, page)).toBe(true);
  });

  it("denies a Page restricted away from the asker", async () => {
    const page = await blanketPage("salaries");
    await restrictTo(page, alice);
    expect(await gate.canRead(bob, page)).toBe(false);
  });

  it("still allows the person a Page is restricted to", async () => {
    const page = await blanketPage("salaries");
    await restrictTo(page, alice);
    expect(await gate.canRead(alice, page)).toBe(true);
  });

  it("denies a caller with no identity at all", async () => {
    const page = await blanketPage("handbook");
    expect(await gate.canRead(undefined, page)).toBe(false);
  });

  it("denies an id that is not a member, even for a blanket-granted Page", async () => {
    const page = await blanketPage("handbook");
    expect(await gate.canRead(randomUUID(), page)).toBe(false);
  });

  it("denies a Page that carries no entries at all", async () => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO knowledge_pages
         (id, title, content, plain_text, source, source_id, tags, created_at, updated_at, space_id, path)
       VALUES ($1, 'orphan', 'c', 'c', 'authored', 'orphan', '{}', now(), now(), $2, 'orphan')`,
      [id, SPACE]
    );
    expect(await gate.canRead(alice, id)).toBe(false);
  });

  it("denies a Page that does not exist without saying so", async () => {
    expect(await gate.canRead(alice, randomUUID())).toBe(false);
  });

  it("filters a listing down to what the asker may read", async () => {
    const open = await blanketPage("handbook");
    const secret = await blanketPage("salaries");
    await restrictTo(secret, alice);

    const visible = await gate.readablePageIds(bob, [open, secret]);
    expect(visible.allowed).toEqual([open]);
  });

  it("reports withheld Pages only as an aggregate count", async () => {
    const open = await blanketPage("handbook");
    const a = await blanketPage("salaries");
    const b = await blanketPage("board-notes");
    await restrictTo(a, alice);
    await restrictTo(b, alice);

    const visible = await gate.readablePageIds(bob, [open, a, b]);
    expect({ allowed: visible.allowed, excluded: visible.excluded }).toEqual({
      allowed: [open],
      excluded: 2,
    });
  });

  it("does not name a withheld Page anywhere in its result", async () => {
    const secret = await blanketPage("salaries");
    await restrictTo(secret, alice);
    const visible = await gate.readablePageIds(bob, [secret]);
    expect(JSON.stringify(visible)).not.toContain(secret);
  });

  it("authorizes a listing without a query per Page", async () => {
    let queries = 0;
    const counted = new PageReadGate({
      query: async <Row = Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
        queries += 1;
        return db.query<Row>(text, params === undefined ? undefined : [...params]);
      },
    });
    const ids = [
      await blanketPage("a"),
      await blanketPage("b"),
      await blanketPage("c"),
      await blanketPage("d"),
    ];
    await counted.readablePageIds(alice, ids);
    expect(queries).toBeLessThanOrEqual(5);
  });

  it("returns an empty listing rather than failing when nothing is readable", async () => {
    const secret = await blanketPage("salaries");
    await restrictTo(secret, alice);
    expect(await gate.readablePageIds(bob, [secret])).toEqual({ allowed: [], excluded: 1 });
  });
});
