// Golden recall@5 eval proving HYBRID retrieval beats LEXICAL-ONLY. One shared bag-of-keywords corpus
// is searched by three arms — lexical-only, vector-only, hybrid (RRF) — and recall@5 is measured for
// each. The corpus carries a deliberate VOCABULARY-MISMATCH case: the true page mentions the query's
// keyword only in its BODY while a crowd of decoy pages match the SAME keyword in their TITLES (which
// the lexical scorer weights far higher), so the true page falls outside the lexical top-5 — yet the
// vector arm ranks it #1 because its body's bag-of-keywords is an exact match for the query's. Hybrid
// fuses the two and recovers it, so recallHybrid strictly exceeds recallLexicalOnly.

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import { PgKnowledgePageRepo, PgKnowledgeRevisionRepo } from "./repo";
import { PageRetrievalService } from "./retrieval-service";
import { KnowledgeService } from "./service";
import type { EmbeddingPort } from "./types";

// ── bag-of-keywords embedding (verbatim from hybrid-search.pg.test.ts) ──────────────────────────────
// Each dim is the count of that keyword in the text. The SAME function embeds chunks AND the query, so
// a query sharing keywords with a chunk yields a high cosine similarity while an unrelated chunk is near
// orthogonal — letting the vector arm genuinely RANK pages.
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
  /** plain_text + the single chunk body (lexical AND vector source). */
  body: string;
}

/** Seed one space page + a single chunk whose embedding is the bag-of-keywords of its body. */
async function seedPage(db: PGlite, p: SeedPage): Promise<void> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO knowledge_pages
       (id, title, content, plain_text, source, source_id, tags, active, always_load_for_agents,
        version, space_id, path, type, frontmatter_extra, created_at, updated_at)
     VALUES ($1,$2,$3,$3,'authored',$4,'{}',true,false,1,$5,$6,NULL,'{}'::jsonb,now(),now())`,
    [id, p.title, `${p.title}\n\n${p.body}`, `okf:${p.spaceId}:${p.path}`, p.spaceId, p.path]
  );
  await db.query(
    `INSERT INTO knowledge_chunks
       (id, page_id, chunk_index, content, content_hash, embedding, tsv, model, dim, created_at)
     VALUES ($1,$2,0,$3,md5($3),$4::vector,to_tsvector('english',$3),'m',$5,now())`,
    [randomUUID(), id, p.body, JSON.stringify(bagEmbed(p.body)), DIM]
  );
}

// ── Shared corpus ───────────────────────────────────────────────────────────────────────────────────
// Eight pages over the bag vocabulary. The first seven are "ordinary" — their title carries the same
// keyword as their body, so BOTH arms find them easily (these keep recall non-trivial for every arm).
// The eighth, "ledger", is the vocabulary-mismatch trap (see GOLDEN below).
interface CorpusPage {
  path: string;
  title: string;
  body: string;
}

const CORPUS: CorpusPage[] = [
  { path: "alpha-doc", title: "Alpha service overview", body: "alpha alpha alpha runbook" },
  { path: "beta-doc", title: "Beta migration guide", body: "beta beta beta steps" },
  { path: "gamma-doc", title: "Gamma rollout plan", body: "gamma gamma gamma notes" },
  { path: "delta-doc", title: "Delta caching layer", body: "delta delta delta config" },
  { path: "eta-doc", title: "Eta tracing setup", body: "eta eta eta spans" },
  { path: "theta-doc", title: "Theta rate limiting", body: "theta theta theta throttle" },
  { path: "zeta-doc", title: "Zeta auth flow", body: "zeta zeta zeta tokens" },

  // ── Vocabulary-mismatch trap (query: "epsilon") ──
  // The true page's title says nothing about "epsilon"; the keyword lives ONLY in its body, where the
  // lexical scorer applies the low body weight (wBody 0.3 vs wTitle 0.7).
  {
    path: "ledger",
    title: "Quarterly accounting summary",
    body: "epsilon epsilon epsilon epsilon",
  },
  // A crowd of decoys whose TITLES all carry "epsilon" (heavy wTitle), so the lexical arm fills its
  // entire top-5 with them and shoves "ledger" out — while none of them match the query's bag as
  // strongly (one "epsilon" in body vs the trap's four), so the vector arm keeps "ledger" at #1.
  { path: "decoy-1", title: "Epsilon greek letter", body: "epsilon glossary" },
  { path: "decoy-2", title: "Epsilon math constant", body: "epsilon calculus" },
  { path: "decoy-3", title: "Epsilon naming convention", body: "epsilon style" },
  { path: "decoy-4", title: "Epsilon transition diagram", body: "epsilon automata" },
  { path: "decoy-5", title: "Epsilon delta proof", body: "epsilon limit" },
  { path: "decoy-6", title: "Epsilon release notes", body: "epsilon changelog" },
];

// query → the path it should retrieve. The first seven are easy (title+body agree). "epsilon" is the
// vocabulary-mismatch case the lexical arm cannot keep in its top-5 but the vector arm rescues.
const GOLDEN: Array<[string, string]> = [
  ["alpha", "alpha-doc"],
  ["beta", "beta-doc"],
  ["gamma", "gamma-doc"],
  ["delta", "delta-doc"],
  ["eta", "eta-doc"],
  ["theta", "theta-doc"],
  ["zeta", "zeta-doc"],
  ["epsilon", "ledger"], // vocabulary-mismatch trap
];

describe("hybrid golden recall@5 (hybrid beats lexical-only)", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    const space = await seedSpace(db);
    for (const p of CORPUS) {
      await seedPage(db, { spaceId: space, path: p.path, title: p.title, body: p.body });
    }
  });
  afterEach(async () => {
    await db.close();
  });

  it("hybrid strictly outperforms lexical-only, matching vector on the vocab-mismatch set", async () => {
    const lexical = new PageRetrievalService(db);
    const chunks = new PgKnowledgeChunkRepo(db);
    const svc = makeService(db, bagEmbeddings(true));

    const recallOf = async (
      top5For: (query: string) => Promise<string[]>
    ): Promise<{ recall: number; misses: string[] }> => {
      let hits = 0;
      const misses: string[] = [];
      for (const [query, expected] of GOLDEN) {
        const top5 = await top5For(query);
        if (top5.includes(expected)) hits += 1;
        else misses.push(`${query} → expected ${expected}, got [${top5.join(", ")}]`);
      }
      return { recall: hits / GOLDEN.length, misses };
    };

    // LEXICAL-ONLY arm.
    const lex = await recallOf(async (query) =>
      (await lexical.searchPages({ query, filters: {}, limit: 5 })).flatMap((h) =>
        h.path ? [h.path] : []
      )
    );

    // VECTOR-ONLY arm: chunk hits grouped to pages (max score per page), top-5 page paths.
    const vec = await recallOf(async (query) => {
      const hits = await chunks.searchVector(bagEmbed(query), DIM, 50, {});
      const best = new Map<string, number>();
      for (const h of hits) best.set(h.pageId, Math.max(best.get(h.pageId) ?? -1, h.score));
      const top5Ids = [...best.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id]) => id);
      const pages = await Promise.all(top5Ids.map((id) => new PgKnowledgePageRepo(db).getById(id)));
      return pages.flatMap((p) => (p?.path ? [p.path] : []));
    });

    // HYBRID arm (RRF fusion of both).
    const hyb = await recallOf(async (query) =>
      (await svc.hybridSearchPages(query, {}, 5)).results.flatMap((r) => (r.path ? [r.path] : []))
    );

    // ── proof (visible to a reader) ──
    console.log(`recall@5  lexical-only = ${lex.recall.toFixed(2)}`);
    console.log(`recall@5  vector-only  = ${vec.recall.toFixed(2)}`);
    console.log(`recall@5  hybrid       = ${hyb.recall.toFixed(2)}`);
    if (lex.misses.length) console.log(`lexical-only misses:\n  ${lex.misses.join("\n  ")}`);

    // The vocab-mismatch case is precisely what the lexical arm cannot keep in its top-5.
    expect(lex.recall, `lexical misses:\n${lex.misses.join("\n")}`).toBeLessThan(1.0);
    // Hybrid is a STRICT, non-tie win over lexical-only…
    expect(hyb.recall).toBeGreaterThan(lex.recall);
    // …at least as good as the vector arm alone…
    expect(hyb.recall).toBeGreaterThanOrEqual(vec.recall);
    // …and recovers the whole designed set.
    expect(hyb.recall).toBe(1.0);
  });
});
