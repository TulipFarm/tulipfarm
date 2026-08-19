/**
 * `query_knowledge` and `cite_sources` obey the Page gate.
 *
 * The exact-lookup Tools were gated; search was not. `hybridSearchOkfPages` runs its vector and
 * lexical arms straight against the corpus with no Principal, so an Agent could reach a restricted
 * Page's title and an 800-character snippet by describing it instead of naming it. `cite_sources`
 * had the same hole in miniature: hand it any Page id and it answers with the title and URL,
 * making it an existence oracle.
 *
 * Denial is indistinguishable from absence, and — the part that is easy to get wrong — it must not
 * be inferable from a *short* result set either. Filtering the requested window rather than an
 * over-fetched one returns fewer hits than asked for exactly when something was withheld, which is
 * the signal itself.
 */

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { EmbeddingPort } from "@tulipfarm/knowledge";
import {
  BLANKET_READ_PRINCIPAL,
  KNOWLEDGE_TOOLS,
  KnowledgeService,
  type KnowledgeToolContext,
  PageReadGate,
  PageRetrievalService,
  PgKnowledgeAclRepo,
  PgKnowledgeChunkRepo,
  PgKnowledgeLinksRepo,
  PgKnowledgePageRepo,
  PgKnowledgeRevisionRepo,
  PgKnowledgeSpaceOverrideRepo,
  PgKnowledgeSpaceRepo,
} from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

const BUSINESS = "tulipfarm-local";

function lexicalOnly(): EmbeddingPort {
  return {
    isAvailable: () => false,
    embedMany: async (values) => ({ embeddings: values.map(() => [0, 0, 0]), dimension: 3 }),
    getActive: () => null,
    getDimension: () => null,
    pendingReindex: () => false,
    clearPendingReindex: () => {},
  };
}

const byName = Object.fromEntries(KNOWLEDGE_TOOLS.map((t) => [t.name, t]));

type Result = { success: boolean; data?: unknown; error?: unknown };
type Hit = { pageId: string; title: string; snippet: string };

describe("Knowledge search Tools obey the Page gate", () => {
  let db: PGlite;
  let service: KnowledgeService;
  let gate: PageReadGate;
  let acl: PgKnowledgeAclRepo;
  let author: string;
  let outsider: string;
  let spaceId: string;
  let openPage: string;
  let closedPage: string;

  const ctx = (userId: string): KnowledgeToolContext => ({ userId, service, pageGate: gate });

  const call = (name: string, args: object, userId: string): Promise<Result> =>
    byName[name].handler(args, ctx(userId)) as Promise<Result>;

  async function search(query: string, userId: string, limit = 10): Promise<Hit[]> {
    const res = await call("query_knowledge", { query, limit }, userId);
    if (!res.success) throw new Error(`query_knowledge failed: ${JSON.stringify(res)}`);
    return (res.data as { results: Hit[] }).results;
  }

  async function addMember(): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, role, created_at)
       VALUES ($1, $2, 'x', 'member', now())`,
      [id, `${id}@example.test`]
    );
    return id;
  }

  async function writePage(path: string, content: string, userId: string): Promise<string> {
    const res = await call("write_page", { spaceId, path, content }, userId);
    if (!res.success) throw new Error(`write_page failed: ${JSON.stringify(res)}`);
    return (res.data as { id: string }).id;
  }

  /** Replace the blanket grant with an allowlist of one — the product's "restrict" action. */
  async function restrictTo(pageId: string, userId: string): Promise<void> {
    await acl.remove(BUSINESS, "page", pageId, BLANKET_READ_PRINCIPAL);
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
    service = new KnowledgeService({
      pages: new PgKnowledgePageRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      spaces: new PgKnowledgeSpaceRepo(db),
      links: new PgKnowledgeLinksRepo(db),
      overrides: new PgKnowledgeSpaceOverrideRepo(db),
      embeddings: lexicalOnly(),
      retrieval: new PageRetrievalService(db),
      acl,
    });
    gate = new PageReadGate(db, BUSINESS);

    author = await addMember();
    outsider = await addMember();

    const sp = await call("create_space", { name: "ops" }, author);
    spaceId = (sp.data as { id: string }).id;

    openPage = await writePage(
      "runbooks/redundancy",
      "---\ntype: Playbook\ntitle: Redundancy in the cluster\n---\n\nWe run redundancy across zones.",
      author
    );
    closedPage = await writePage(
      "hr/redundancy",
      "---\ntype: Playbook\ntitle: Redundancy programme\n---\n\nWe will make redundancy offers to the named staff.",
      author
    );
    await restrictTo(closedPage, author);
  });

  afterEach(async () => {
    await db.close();
  });

  it("serves the author every Page that matches", async () => {
    const ids = (await search("redundancy", author)).map((h) => h.pageId);
    expect(ids).toContain(openPage);
    expect(ids).toContain(closedPage);
  });

  it("withholds a restricted Page from an outsider's search", async () => {
    const ids = (await search("redundancy", outsider)).map((h) => h.pageId);
    expect(ids).toContain(openPage);
    expect(ids).not.toContain(closedPage);
  });

  it("leaks neither the restricted Page's title nor its body in the snippet", async () => {
    const hits = await search("redundancy offers named staff", outsider);
    const text = JSON.stringify(hits);
    expect(text).not.toContain("Redundancy programme");
    expect(text).not.toContain("named staff");
  });

  it("still fills the requested window, so a short result set is not the tell", async () => {
    // Three restricted Pages that repeat the term, and three open ones that mention it once. FTS
    // ranks by term frequency, so the restricted three own the top of the ranking. Asking for
    // three means the whole requested window is denied: only an over-fetch can reach past them to
    // the open Pages. Filtering the requested window would answer empty, and empty-when-matches-
    // exist is the disclosure.
    for (const n of [1, 2, 3]) {
      await writePage(
        `hr/severance-${n}`,
        `---\ntype: Playbook\ntitle: Severance severance severance ${n}\n---\n\nSeverance severance severance severance severance.`,
        author
      );
    }
    const restricted = await service.listPages({ spaceId, limit: 100 });
    for (const p of restricted.items) {
      if (p.path?.startsWith("hr/severance-")) await restrictTo(p._id, author);
    }
    for (const n of [1, 2, 3]) {
      await writePage(
        `runbooks/severance-note-${n}`,
        `---\ntype: Playbook\ntitle: Note ${n}\n---\n\nA passing mention of severance.`,
        author
      );
    }

    const hits = await search("severance", outsider, 3);

    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.title.startsWith("Note"))).toBe(true);
  });

  it("answers a corpus of only restricted Pages exactly as an empty corpus", async () => {
    await restrictTo(openPage, author);
    expect(await search("redundancy", outsider)).toEqual([]);
  });

  it("cite_sources resolves a Page the actor may read", async () => {
    const res = await call("cite_sources", { citations: [{ ref: 1, pageId: openPage }] }, outsider);
    expect((res.data as { sources: unknown[] }).sources).toHaveLength(1);
  });

  it("cite_sources answers a restricted Page exactly as an unknown id", async () => {
    const withheld = await call(
      "cite_sources",
      { citations: [{ ref: 1, pageId: closedPage }] },
      outsider
    );
    const unknown = await call(
      "cite_sources",
      { citations: [{ ref: 1, pageId: randomUUID() }] },
      outsider
    );

    expect(withheld).toEqual(unknown);
  });

  /**
   * A host that forgot to wire the gate must refuse, not serve. Production wires it in
   * `apps/api/src/index.ts` and passes it through `tools/setup.ts`; a fixture that omits it is
   * declaring it is not testing access control, and gets nothing rather than everything.
   */
  it("serves no authored Page at all when the host wired no gate", async () => {
    const ungated = { userId: author, service } as KnowledgeToolContext;

    const searched = (await byName.query_knowledge.handler(
      { query: "redundancy", limit: 10 },
      ungated
    )) as Result;
    const cited = (await byName.cite_sources.handler(
      { citations: [{ ref: 1, pageId: openPage }] },
      ungated
    )) as Result;

    expect((searched.data as { results: unknown[] }).results).toEqual([]);
    expect((cited.data as { sources: unknown[] }).sources).toEqual([]);
  });
});
