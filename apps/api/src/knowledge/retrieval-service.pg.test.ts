import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { DEFAULT_RANKING } from "./retrieval-config";
import { extractHighlights, PageRetrievalService, toPrefixTsQuery } from "./retrieval-service";

async function seedBundle(db: PGlite, name = `b-${randomUUID()}`): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO knowledge_bundles (id, name, description, created_at, updated_at)
     VALUES ($1, $2, NULL, now(), now())`,
    [id, name]
  );
  return id;
}

interface SeedPage {
  bundleId: string;
  path: string;
  title: string;
  /** Becomes plain_text and (unless `chunks` given) the single chunk body. */
  body: string;
  type?: string | null;
  updatedAt?: Date;
  /** Explicit chunk contents; `[]` = a page with no chunks (title-only). */
  chunks?: string[];
}

async function seedPage(db: PGlite, p: SeedPage): Promise<string> {
  const id = randomUUID();
  const updated = p.updatedAt ?? new Date();
  await db.query(
    `INSERT INTO knowledge_documents
       (id, title, content, plain_text, source, source_id, tags, active, always_load_for_agents,
        version, bundle_id, path, type, frontmatter_extra, created_at, updated_at)
     VALUES ($1,$2,$3,$3,'authored',$4,'{}',true,false,1,$5,$6,$7,'{}'::jsonb,now(),$8)`,
    [
      id,
      p.title,
      p.body,
      `okf:${p.bundleId}:${p.path}`,
      p.bundleId,
      p.path,
      p.type ?? null,
      updated,
    ]
  );
  const chunks = p.chunks ?? [p.body];
  for (let i = 0; i < chunks.length; i += 1) {
    await db.query(
      `INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, embedding, tsv, model, dim, created_at)
       VALUES ($1,$2,$3,$4,NULL,to_tsvector('english',$4),'m',3,now())`,
      [randomUUID(), id, i, chunks[i]]
    );
  }
  return id;
}

const DAY = 24 * 60 * 60 * 1000;

describe("PageRetrievalService.searchPages", () => {
  let db: PGlite;
  let svc: PageRetrievalService;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    // Explicit config so the trgm pass is deterministic regardless of the env flag.
    svc = new PageRetrievalService(db, { ...DEFAULT_RANKING, trgmFallback: true });
  });
  afterEach(async () => {
    await db.close();
  });

  it("groups chunks to one page hit, scored by the best (max) chunk", async () => {
    const b = await seedBundle(db);
    await seedPage(db, {
      bundleId: b,
      path: "strong",
      title: "Strong",
      body: "intro",
      chunks: ["alpha alpha alpha beta", "totally unrelated text"],
    });
    await seedPage(db, { bundleId: b, path: "weak", title: "Weak", body: "alpha once only" });

    const hits = await svc.searchPages({ query: "alpha", filters: {}, limit: 10 });
    const strong = hits.filter((h) => h.path === "strong");
    expect(strong).toHaveLength(1); // grouped — appears once despite two matching docs
    expect(hits[0].path).toBe("strong"); // higher max-chunk rank wins
  });

  it("ranks an exact title match above a body-only mention", async () => {
    const b = await seedBundle(db);
    await seedPage(db, { bundleId: b, path: "guide", title: "Onboarding Guide", body: "welcome" });
    await seedPage(db, {
      bundleId: b,
      path: "misc",
      title: "Misc Notes",
      body: "a stray onboarding reference buried in the body",
    });

    const hits = await svc.searchPages({ query: "onboarding", filters: {}, limit: 10 });
    expect(hits[0].path).toBe("guide");
  });

  it("breaks ties by recency (more recent updated_at ranks higher)", async () => {
    const b = await seedBundle(db);
    const now = Date.now();
    await seedPage(db, {
      bundleId: b,
      path: "fresh",
      title: "Quarterly Metrics",
      body: "quarterly metrics report",
      updatedAt: new Date(now - 5 * DAY),
    });
    await seedPage(db, {
      bundleId: b,
      path: "stale",
      title: "Quarterly Metrics",
      body: "quarterly metrics report",
      updatedAt: new Date(now - 200 * DAY),
    });

    const hits = await svc.searchPages({ query: "quarterly metrics", filters: {}, limit: 10 });
    expect(hits.map((h) => h.path)).toEqual(["fresh", "stale"]);
  });

  it("narrows by the bundle (space) facet", async () => {
    const b1 = await seedBundle(db);
    const b2 = await seedBundle(db);
    await seedPage(db, {
      bundleId: b1,
      path: "a",
      title: "Report One",
      body: "shared term widget",
    });
    await seedPage(db, {
      bundleId: b2,
      path: "b",
      title: "Report Two",
      body: "shared term widget",
    });

    const scoped = await svc.searchPages({ query: "widget", filters: { bundleId: b1 }, limit: 10 });
    expect(scoped.map((h) => h.bundleId)).toEqual([b1]);
  });

  it("narrows by the type facet", async () => {
    const b = await seedBundle(db);
    await seedPage(db, { bundleId: b, path: "t1", title: "Orders", body: "schema", type: "table" });
    await seedPage(db, {
      bundleId: b,
      path: "p1",
      title: "Runbook",
      body: "schema",
      type: "playbook",
    });

    const tables = await svc.searchPages({
      query: "schema",
      filters: { type: "table" },
      limit: 10,
    });
    expect(tables.map((h) => h.path)).toEqual(["t1"]);
  });

  it("returns a title-only page (no chunks) using plain_text for the snippet", async () => {
    const b = await seedBundle(db);
    await seedPage(db, {
      bundleId: b,
      path: "titleonly",
      title: "Kubernetes Deployment",
      body: "this body never gets chunked",
      chunks: [],
    });

    const hits = await svc.searchPages({ query: "kubernetes", filters: {}, limit: 10 });
    expect(hits.map((h) => h.path)).toEqual(["titleonly"]);
    expect(hits[0].snippet).toContain("body never gets chunked"); // COALESCE(best_chunk, plain_text)
  });

  it("matches a word prefix (as-you-type): 'frid' finds a body 'Friday'", async () => {
    const b = await seedBundle(db);
    await seedPage(db, {
      bundleId: b,
      path: "rb",
      title: "Deploy Runbook",
      body: "Never deploy on a Friday.",
    });
    const hits = await svc.searchPages({ query: "frid", filters: {}, limit: 10 });
    expect(hits.map((h) => h.path)).toContain("rb");
  });

  it("recovers a typo via the pg_trgm recall pass when the primary finds nothing", async () => {
    const b = await seedBundle(db);
    await seedPage(db, { bundleId: b, path: "pb", title: "Playbook", body: "incident steps" });

    const hits = await svc.searchPages({ query: "playbok", filters: {}, limit: 10 });
    expect(hits.map((h) => h.path)).toContain("pb");
  });

  it("does NOT run the trgm pass when disabled", async () => {
    const b = await seedBundle(db);
    await seedPage(db, { bundleId: b, path: "pb", title: "Playbook", body: "incident steps" });
    const noTrgm = new PageRetrievalService(db, { ...DEFAULT_RANKING, trgmFallback: false });

    const hits = await noTrgm.searchPages({ query: "playbok", filters: {}, limit: 10 });
    expect(hits).toHaveLength(0);
  });

  it("populates highlightRanges for a body match", async () => {
    const b = await seedBundle(db);
    await seedPage(db, {
      bundleId: b,
      path: "h",
      title: "Doc",
      body: "the quick brown widget jumps",
    });

    const hits = await svc.searchPages({ query: "widget", filters: {}, limit: 10 });
    expect(hits[0].highlightRanges.length).toBeGreaterThan(0);
    const [start, end] = hits[0].highlightRanges[0];
    expect(hits[0].snippet.slice(start, end).toLowerCase()).toContain("widget");
  });
});

describe("PageRetrievalService.recentPages", () => {
  let db: PGlite;
  let svc: PageRetrievalService;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    svc = new PageRetrievalService(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("returns pages by updated_at desc, honoring the limit and bundle filter", async () => {
    const b1 = await seedBundle(db);
    const b2 = await seedBundle(db);
    const now = Date.now();
    await seedPage(db, {
      bundleId: b1,
      path: "old",
      title: "Old",
      body: "x",
      updatedAt: new Date(now - 9 * DAY),
    });
    await seedPage(db, {
      bundleId: b1,
      path: "new",
      title: "New",
      body: "y",
      updatedAt: new Date(now - 1 * DAY),
    });
    await seedPage(db, {
      bundleId: b2,
      path: "other",
      title: "Other",
      body: "z",
      updatedAt: new Date(now),
    });

    const recent = await svc.recentPages(10, { bundleId: b1 });
    expect(recent.map((h) => h.path)).toEqual(["new", "old"]);

    const capped = await svc.recentPages(1);
    expect(capped).toHaveLength(1);
    expect(capped[0].path).toBe("other"); // most recent across all bundles
  });
});

describe("toPrefixTsQuery", () => {
  it("builds AND-joined prefix patterns from alphanumeric terms", () => {
    expect(toPrefixTsQuery("frid")).toBe("frid:*");
    expect(toPrefixTsQuery("Deploy Frid")).toBe("deploy:* & frid:*");
    expect(toPrefixTsQuery("a-b.c")).toBe("a:* & b:* & c:*");
    expect(toPrefixTsQuery("   !!!   ")).toBe("");
  });
});

describe("extractHighlights", () => {
  it("strips <<…>> markers and returns matched ranges into the clean text", () => {
    const { snippet, highlightRanges } = extractHighlights("the <<quick>> brown <<fox>>");
    expect(snippet).toBe("the quick brown fox");
    expect(highlightRanges).toEqual([
      [4, 9],
      [16, 19],
    ]);
    expect(snippet.slice(4, 9)).toBe("quick");
    expect(snippet.slice(16, 19)).toBe("fox");
  });

  it("tolerates no markers and an unterminated marker", () => {
    expect(extractHighlights("plain text").highlightRanges).toEqual([]);
    expect(extractHighlights("a <<dangling").snippet).toBe("a <<dangling");
  });
});
