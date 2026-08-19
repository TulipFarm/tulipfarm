/**
 * Inheritance resolves an ancestor by *path*, and paths are only unique within a Space
 * (`knowledge_pages_space_path_idx` is UNIQUE on `(space_id, path)`). Two Spaces are expected to
 * both have a `handbook` — that is the point of Spaces.
 *
 * If the ancestor lookup ignores `space_id`, a Page inherits from whichever Space's row the
 * database happened to return first. A restricted parent's allowlist is then replaced by the other
 * Space's blanket grant, and the child becomes readable by everyone. It fails on physical row
 * order, so it fails intermittently — which is why each case here is run with both insertion
 * orders.
 */

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { EmbeddingPort } from "@tulipfarm/knowledge";
import {
  BLANKET_READ_PRINCIPAL,
  KnowledgeService,
  PageReadGate,
  PgKnowledgeAclRepo,
  PgKnowledgeChunkRepo,
  PgKnowledgeLinksRepo,
  PgKnowledgePageRepo,
  PgKnowledgeRevisionRepo,
  PgKnowledgeSpaceOverrideRepo,
  PgKnowledgeSpaceRepo,
  PgKnowledgeSubjectStore,
} from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

function noEmbeddings(): EmbeddingPort {
  return {
    isAvailable: () => false,
    embedMany: async (values) => ({ embeddings: values.map(() => [0, 0, 0]), dimension: 3 }),
    getActive: () => null,
    getDimension: () => null,
    pendingReindex: () => false,
    clearPendingReindex: () => {},
  };
}

describe("inheritance does not cross Space boundaries", () => {
  let db: PGlite;
  let service: KnowledgeService;
  let acl: PgKnowledgeAclRepo;
  let subjects: PgKnowledgeSubjectStore;
  let gate: PageReadGate;

  async function addMember(name: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', $3, 'member', 'active', now())`,
      [id, `${name}-${id}@example.com`, name]
    );
    return id;
  }

  async function makeSpace(name: string): Promise<string> {
    const created = await service.createSpace({ name });
    if (!created.ok) throw new Error(`space ${name} failed`);
    return created.space._id;
  }

  async function writePage(spaceId: string, path: string): Promise<string> {
    const res = await service.writePage({ spaceId, path, content: `# ${path}\n\nbody` });
    if (!res.ok || !("page" in res)) throw new Error(`write ${path} failed`);
    return res.page._id;
  }

  async function restrictTo(pageId: string, userId: string): Promise<void> {
    await acl.remove(DEPLOYMENT_BUSINESS_ID, "page", pageId, BLANKET_READ_PRINCIPAL);
    await acl.put({
      businessId: DEPLOYMENT_BUSINESS_ID,
      subjectKind: "page",
      subjectId: pageId,
      principal: { kind: "user", id: userId },
      capability: "read",
      effect: "grant",
      origin: "authored",
    });
  }

  /**
   * Builds the collision: a `handbook` in each of two Spaces, only one of them restricted, and a
   * child under the restricted one. `decoyFirst` controls which Space's `handbook` row is written
   * first, which is the only thing an unscoped lookup is sensitive to.
   */
  async function collide(decoyFirst: boolean): Promise<{
    alice: string;
    bob: string;
    child: string;
    restrictedParent: string;
  }> {
    const alice = await addMember("alice");
    const bob = await addMember("bob");
    const closed = await makeSpace("Closed");
    const decoy = await makeSpace("Decoy");

    let restrictedParent: string;
    if (decoyFirst) {
      await writePage(decoy, "handbook");
      restrictedParent = await writePage(closed, "handbook");
    } else {
      restrictedParent = await writePage(closed, "handbook");
      await writePage(decoy, "handbook");
    }
    await restrictTo(restrictedParent, alice);
    const child = await writePage(closed, "handbook/pay");
    return { alice, bob, child, restrictedParent };
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    acl = new PgKnowledgeAclRepo(db);
    subjects = new PgKnowledgeSubjectStore(db);
    gate = new PageReadGate(db);
    service = new KnowledgeService({
      pages: new PgKnowledgePageRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      spaces: new PgKnowledgeSpaceRepo(db),
      links: new PgKnowledgeLinksRepo(db),
      overrides: new PgKnowledgeSpaceOverrideRepo(db),
      embeddings: noEmbeddings(),
      acl,
    });
  });

  afterEach(async () => {
    await db.close();
  });

  for (const decoyFirst of [true, false]) {
    const order = decoyFirst ? "the open Space's Page written first" : "written second";

    it(`withholds a child of a restricted parent — ${order}`, async () => {
      const { alice, bob, child } = await collide(decoyFirst);

      expect(await gate.canRead(alice, child)).toBe(true);
      expect(await gate.canRead(bob, child)).toBe(false);
    });

    it(`labels the child inherited-restricted, naming its own Space's parent — ${order}`, async () => {
      const { child, restrictedParent } = await collide(decoyFirst);

      const scopes = await subjects.scopesOf(DEPLOYMENT_BUSINESS_ID, [child]);
      expect(scopes.get(child)).toEqual({
        scope: "inherited",
        inheritedFrom: { kind: "page", id: restrictedParent },
      });
    });

    it(`reports only the parent's readers, not the whole Business — ${order}`, async () => {
      const { alice, bob, child } = await collide(decoyFirst);

      const visibility = await subjects.visibilityOf(DEPLOYMENT_BUSINESS_ID, child);
      const readerIds = (visibility?.readers ?? []).map((r) => r.id);
      expect(readerIds).toContain(alice);
      expect(readerIds).not.toContain(bob);
      expect(readerIds).not.toContain(BLANKET_READ_PRINCIPAL.id);
    });
  }

  it("still inherits from a same-Space ancestor, so the scoping did not just switch inheritance off", async () => {
    const alice = await addMember("alice");
    const bob = await addMember("bob");
    const closed = await makeSpace("Closed");
    const parent = await writePage(closed, "handbook");
    await restrictTo(parent, alice);
    const child = await writePage(closed, "handbook/pay");

    expect(await gate.canRead(bob, child)).toBe(false);
    expect(await gate.canRead(alice, child)).toBe(true);
  });

  it("leaves an unrelated Space's Page at the same path open", async () => {
    const alice = await addMember("alice");
    const bob = await addMember("bob");
    const closed = await makeSpace("Closed");
    const open = await makeSpace("Open");
    const parent = await writePage(closed, "handbook");
    await restrictTo(parent, alice);
    await writePage(closed, "handbook/pay");
    const openChild = await writePage(open, "handbook/pay");

    expect(await gate.canRead(bob, openChild)).toBe(true);
  });

  /**
   * The batch path is the one the SQL scoping cannot save. `scopesOf` asks for both Spaces' Pages
   * in one call, so both `handbook` rows are legitimately in the result set and only a
   * Space-qualified key tells them apart. Without it, whichever row lands in the map first decides
   * the inheritance for *both* children.
   */
  it("keeps two Spaces' identical paths apart when both are resolved in one batch", async () => {
    const alice = await addMember("alice");
    const closed = await makeSpace("Closed");
    const open = await makeSpace("Open");
    const restrictedParent = await writePage(closed, "handbook");
    await writePage(open, "handbook");
    await restrictTo(restrictedParent, alice);
    const closedChild = await writePage(closed, "handbook/pay");
    const openChild = await writePage(open, "handbook/pay");

    const scopes = await subjects.scopesOf(DEPLOYMENT_BUSINESS_ID, [closedChild, openChild]);

    expect(scopes.get(closedChild)).toEqual({
      scope: "inherited",
      inheritedFrom: { kind: "page", id: restrictedParent },
    });
    expect(scopes.get(openChild)).toEqual({ scope: "business", inheritedFrom: null });
  });
});
