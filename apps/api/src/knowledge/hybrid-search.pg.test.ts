import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { EMBEDDING_UNAVAILABLE_WARNING } from "@tulipfarm/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import { PageRetrievalService } from "./page-search-adapter";
import { PgKnowledgePageRepo, PgKnowledgeRevisionRepo } from "./repo";
import { KnowledgeService } from "./service";
import type { EmbeddingPort } from "./types";

// ── bag-of-keywords embedding ──────────────────────────────────────────────────────────────────
// A deterministic embedding over a tiny fixed vocabulary: each dim is the count of that keyword in
// the text. The SAME function embeds indexed chunks AND the query, so a query sharing keywords with a
// chunk yields a high cosine similarity (overlapping non-zero dims) while an unrelated chunk is near
// orthogonal. This lets the vector arm genuinely RANK pages — unlike a uniform stub.
const VOCAB = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
const DIM = VOCAB.length;

function bagEmbed(text: string): number[] {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return VOCAB.map((kw) => words.filter((w) => w === kw).length);
}

function bagEmbeddings(available: boolean): EmbeddingPort {
  return {
    isAvailable: () => available,
    embedMany: async (values) => ({
      embeddings: values.map((v) => bagEmbed(v)),
      dimension: DIM,
    }),
    getActive: () => (available ? { provider: "fake", model: "m", dimension: DIM } : null),
    getDimension: () => (available ? DIM : null),
    consumePendingReindex: () => false,
  };
}

function makeService(db: PGlite, embeddings: EmbeddingPort): KnowledgeService {
  return new KnowledgeService({
    pages: new PgKnowledgePageRepo(db),
    chunks: new PgKnowledgeChunkRepo(db),
    revisions: new PgKnowledgeRevisionRepo(db),
    embeddings,
    retrieval: new PageRetrievalService(db),
  });
}

async function seedSpace(db: PGlite): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO knowledge_spaces (id, name, description, created_at, updated_at)
     VALUES ($1, $2, NULL, now(), now())`,
    [id, `space-${id}`]
  );
  return id;
}

interface SeedPage {
  spaceId: string;
  path: string;
  title: string;
  /** plain_text + the single chunk body (lexical AND vector source — both arms see the same text). */
  body: string;
  /** When set, the chunk embeds (and the page indexes) lexical-only — no vector. Default embeds. */
  embed?: boolean;
}

/** Seed one space page + a single chunk whose embedding is the bag-of-keywords of its body. */
async function seedPage(db: PGlite, p: SeedPage): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO knowledge_pages
       (id, title, content, plain_text, source, source_id, tags, active, always_load_for_agents,
        version, space_id, path, type, frontmatter_extra, created_at, updated_at)
     VALUES ($1,$2,$3,$3,'authored',$4,'{}',true,false,1,$5,$6,NULL,'{}'::jsonb,now(),now())`,
    [id, p.title, `${p.title}\n\n${p.body}`, `okf:${p.spaceId}:${p.path}`, p.spaceId, p.path]
  );
  const vec = p.embed === false ? null : JSON.stringify(bagEmbed(p.body));
  await db.query(
    `INSERT INTO knowledge_chunks
       (id, page_id, chunk_index, content, content_hash, embedding, tsv, model, dim, created_at)
     VALUES ($1,$2,0,$3,md5($3),$4::vector,to_tsvector('english',$3),$5,$6,now())`,
    [randomUUID(), id, p.body, vec, p.embed === false ? null : "m", p.embed === false ? null : DIM]
  );
  return id;
}

describe("KnowledgeService.hybridSearchPages", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makeMigratedPglite();
  });
  afterEach(async () => {
    await db.close();
  });

  it("RRF lifts a page agreed by BOTH arms above one matched by only ONE arm", async () => {
    const space = await seedSpace(db);
    const svc = makeService(db, bagEmbeddings(true));

    // Query keywords: alpha beta gamma → vector [1,1,1,0,0,0,0,0].
    const query = "alpha beta gamma";

    // Page A — agreed by BOTH arms. Its title carries the query keywords (→ lexical hit) and its chunk
    // embeds the very same keywords (→ vector hit). A is therefore a MEMBER of both result sets.
    const aId = await seedPage(db, {
      spaceId: space,
      path: "page-a",
      title: "Alpha Beta Gamma overview",
      body: "alpha beta gamma deployment notes",
    });

    // Page B — matched by EXACTLY ONE arm (lexical). Its title carries the query keywords (→ lexical
    // hit), but its chunk stores NO embedding (`embed: false`), so the vector arm — which filters on
    // `embedding IS NOT NULL` — cannot return it at all. B is absent from the vector result set.
    const bId = await seedPage(db, {
      spaceId: space,
      path: "page-b",
      title: "Alpha Beta Gamma reference",
      body: "alpha beta gamma appendix",
      embed: false,
    });

    // A neutral filler so neither arm degenerates to a 1-element list (keeps the fusion non-trivial).
    await seedPage(db, {
      spaceId: space,
      path: "filler-1",
      title: "Delta epsilon digest",
      body: "delta epsilon zeta unrelated",
    });

    // ── Sanity-check arm MEMBERSHIP (deterministic; no reliance on exact positions or weights) ──
    const lex = await new PageRetrievalService(db).searchPages({ query, filters: {}, limit: 20 });
    const lexIds = lex.map((h) => h.pageId);
    expect(lexIds).toContain(aId); // A is in the lexical arm
    expect(lexIds).toContain(bId); // B is in the lexical arm

    const { embeddings: qv } = await bagEmbeddings(true).embedMany([query]);
    const vHits = await new PgKnowledgeChunkRepo(db).searchVector(qv[0], DIM, 20, {});
    const vIds = [...new Set(vHits.map((h) => h.pageId))];
    expect(vIds).toContain(aId); // A is in the vector arm (cross-arm agreement)
    expect(vIds).not.toContain(bId); // B has no embedding → absent from the vector arm

    // Invariant: A is hit by BOTH rankers, B by only one → RRF cross-arm agreement lifts A above B.
    const { results } = await svc.hybridSearchPages(query, {}, 10);
    const ids = results.map((r) => r.pageId);
    expect(ids).toContain(aId);
    expect(ids).toContain(bId);
    expect(ids.indexOf(aId)).toBeLessThan(ids.indexOf(bId));
  });

  it("hydrates a vector-only hit (matched semantically, not lexically)", async () => {
    const space = await seedSpace(db);
    const svc = makeService(db, bagEmbeddings(true));

    // Query: zeta — a keyword the lexical arm can't reach because the page's text spells it
    // differently ("Z-page" / "the seventh letter") yet its chunk embeds with the zeta dim set, so the
    // vector arm matches it. The hybrid result must still hydrate from pages.getById.
    const id = await seedPage(db, {
      spaceId: space,
      path: "vault/secrets",
      title: "The seventh letter",
      body: "zeta zeta zeta",
    });

    const { results } = await svc.hybridSearchPages("zeta", {}, 10);
    const hit = results.find((r) => r.pageId === id);
    expect(hit).toBeDefined();
    if (!hit) return;
    expect(hit.title).toBe("The seventh letter"); // hydrated from pages.getById
    expect(hit.spaceId).toBe(space);
    expect(hit.path).toBe("vault/secrets");
    expect(hit.snippet.length).toBeGreaterThan(0);
  });

  it("degrades to the lexical arm with a warning when embeddings are unavailable", async () => {
    const space = await seedSpace(db);
    // Provider unavailable → chunks store lexical-only (NULL embedding), and the vector arm is skipped.
    const svc = makeService(db, bagEmbeddings(false));
    const id = await seedPage(db, {
      spaceId: space,
      path: "runbook",
      title: "Deploy runbook",
      body: "alpha beta gamma deploy steps",
      embed: false,
    });

    const { results, warnings } = await svc.hybridSearchPages("alpha", {}, 10);
    expect(warnings).toContain(EMBEDDING_UNAVAILABLE_WARNING);
    expect(results.map((r) => r.pageId)).toContain(id);
  });
});
