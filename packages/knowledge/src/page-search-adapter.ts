// Page-level lexical retrieval: groups chunk hits up to pages, fuses title/body/recency,
// and optionally widens recall with pg_trgm. Chunk search stays in search-service.ts.

import type { Queryable } from "@tulipfarm/storage";
import { pageFilterConditions, toPrefixTsQuery } from "./chunks-repo";
import { DEFAULT_RANKING, type RankingConfig } from "./retrieval-config";
import type { SearchFilters } from "./types";

/** A whole-page search hit (one row per page, best chunk supplies the snippet). */
export interface PageHit {
  pageId: string;
  title: string;
  spaceId: string | null;
  path: string | null;
  /** Plain-text snippet with highlight markers already stripped. */
  snippet: string;
  /** [start, end) character ranges into `snippet` that matched the query. */
  highlightRanges: Array<[number, number]>;
  /** "agent" when an Agent wrote the Page. Null means unknown, never "a person wrote it". */
  authorKind: "user" | "agent" | null;
  score: number;
}

/** ACL seam: searcher is threaded so future SQL can add permission predicates. */
export type Principal = { userId?: string | null };

export interface PageSearchInput {
  query: string;
  filters: SearchFilters;
  limit: number;
  principal?: Principal;
}

// ts_headline uses unlikely markers; convert them to highlightRanges.
const SEL_START = "<<";
const SEL_STOP = ">>";

/** Strip `<<…>>` markers, returning clean text and match ranges. */
export function extractHighlights(marked: string): {
  snippet: string;
  highlightRanges: Array<[number, number]>;
} {
  const ranges: Array<[number, number]> = [];
  let out = "";
  let i = 0;
  while (i < marked.length) {
    if (marked.startsWith(SEL_START, i)) {
      const end = marked.indexOf(SEL_STOP, i + SEL_START.length);
      if (end === -1) {
        out += marked.slice(i);
        break;
      }
      const term = marked.slice(i + SEL_START.length, end);
      const start = out.length;
      out += term;
      ranges.push([start, out.length]);
      i = end + SEL_STOP.length;
    } else {
      out += marked[i];
      i += 1;
    }
  }
  return { snippet: out, highlightRanges: ranges };
}

function rowToPageHit(row: Record<string, unknown>, score: number): PageHit {
  const { snippet, highlightRanges } = extractHighlights((row.snippet as string | null) ?? "");
  return {
    pageId: row.page_id as string,
    title: row.title as string,
    spaceId: (row.space_id as string | null) ?? null,
    path: (row.path as string | null) ?? null,
    snippet,
    highlightRanges,
    authorKind: (row.author_kind as "user" | "agent" | null) ?? null,
    score,
  };
}

export class PageRetrievalService {
  constructor(
    private readonly q: Queryable,
    private readonly cfg: RankingConfig = DEFAULT_RANKING
  ) {}

  /** Whole-page lexical search, with optional trgm recall. */
  async searchPages(input: PageSearchInput): Promise<PageHit[]> {
    const { query, filters, limit } = input;
    // Prefix FTS for as-you-type matching; skip when there are no usable terms.
    const tsq = toPrefixTsQuery(query);
    const primary = tsq === "" ? [] : await this.runPrimary(tsq, filters, limit);
    if (!this.cfg.trgmFallback || primary.length >= this.cfg.trgmThreshold) return primary;

    const seen = new Set(primary.map((h) => h.pageId));
    const fuzzy = (await this.runTrgm(query, filters, limit)).filter((h) => !seen.has(h.pageId));
    // Primary hits stay on top; trgm-only hits fill the tail by similarity.
    return [...primary, ...fuzzy].slice(0, limit);
  }

  /** Zero-query state: most-recently-updated pages. */
  async recentPages(limit: number, filters: SearchFilters = {}): Promise<PageHit[]> {
    const params: unknown[] = [];
    const filterSql = this.filterSql(filters, params);
    params.push(limit);
    const { rows } = await this.q.query(
      `SELECT p.id AS page_id, p.title, p.space_id, p.path, p.author_kind,
              left(p.plain_text, 200) AS snippet
       FROM knowledge_pages p
       WHERE p.active = true AND p.space_id IS NOT NULL AND p.path IS NOT NULL${filterSql}
       ORDER BY p.updated_at DESC, p.id
       LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => rowToPageHit(r, 0));
  }

  private async runPrimary(tsq: string, filters: SearchFilters, limit: number): Promise<PageHit[]> {
    // $1 prefix tsquery · $2 wTitle · $3 wBody · $4 halflife · [filters…] · $last limit.
    const params: unknown[] = [
      tsq,
      this.cfg.wTitle,
      this.cfg.wBody,
      this.cfg.recencyHalflifeSeconds,
    ];
    const filterSql = this.filterSql(filters, params);
    params.push(limit);
    const { rows } = await this.q.query(
      `WITH q AS (SELECT to_tsquery('english', $1) AS tsq),
       chunk_hits AS (
         SELECT c.page_id,
                max(ts_rank(c.tsv, q.tsq)) AS max_chunk_rank,
                (array_agg(c.content ORDER BY ts_rank(c.tsv, q.tsq) DESC))[1] AS best_chunk
         FROM knowledge_chunks c, q
         WHERE c.tsv @@ q.tsq
         GROUP BY c.page_id)
       SELECT p.id AS page_id, p.title, p.space_id, p.path, p.author_kind,
              ( $2::float8 * ts_rank(p.title_tsv, q.tsq)
              + $3::float8 * COALESCE(ch.max_chunk_rank, 0) )
                * exp(-extract(epoch FROM (now() - p.updated_at)) * ln(2) / $4::float8) AS score,
              ts_headline('english', COALESCE(ch.best_chunk, p.plain_text), q.tsq,
                'StartSel=${SEL_START},StopSel=${SEL_STOP},MaxFragments=2,MinWords=5,MaxWords=18') AS snippet
       FROM knowledge_pages p
       CROSS JOIN q
       LEFT JOIN chunk_hits ch ON ch.page_id = p.id
       WHERE p.active = true AND p.space_id IS NOT NULL AND p.path IS NOT NULL
         AND (p.title_tsv @@ q.tsq OR ch.page_id IS NOT NULL)${filterSql}
       ORDER BY score DESC
       LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => rowToPageHit(r, Number((r as { score: number }).score)));
  }

  private async runTrgm(query: string, filters: SearchFilters, limit: number): Promise<PageHit[]> {
    // pg_trgm recall pass: `%` uses title trigram index and default 0.3 threshold.
    const params: unknown[] = [query];
    const filterSql = this.filterSql(filters, params);
    params.push(limit);
    const { rows } = await this.q.query(
      `SELECT p.id AS page_id, p.title, p.space_id, p.path, p.author_kind,
              left(p.plain_text, 200) AS snippet,
              similarity(p.title, $1) AS sim
       FROM knowledge_pages p
       WHERE p.active = true AND p.space_id IS NOT NULL AND p.path IS NOT NULL
         AND p.title % $1${filterSql}
       ORDER BY sim DESC, p.id
       LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => rowToPageHit(r, Number((r as { sim: number }).sim)));
  }

  /** Build the `p.`-aliased filter SQL fragment. */
  private filterSql(filters: SearchFilters, params: unknown[]): string {
    const conds = pageFilterConditions(filters, params);
    return conds.length > 0 ? ` AND ${conds.join(" AND ")}` : "";
  }
}
