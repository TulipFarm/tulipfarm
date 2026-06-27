// Page-level lexical retrieval — the human-search spine (Plan 1). Groups chunk hits up to whole pages,
// fuses a title-tsv rank with the best body chunk, applies recency decay, and (optionally) widens recall
// with a pg_trgm typo-tolerance pass. Chunk-level search stays in search-service.ts; this is page mode.

import type { Queryable } from "../db";
import { docFilterConditions } from "./chunks-repo";
import { DEFAULT_RANKING, type RankingConfig } from "./retrieval-config";
import type { SearchFilters } from "./types";

/** A whole-page search hit (one row per document, best chunk supplies the snippet). */
export interface PageHit {
  documentId: string;
  title: string;
  bundleId: string | null;
  path: string | null;
  /** Plain-text snippet with highlight markers already stripped. */
  snippet: string;
  /** [start, end) character ranges into `snippet` that matched the query. */
  highlightRanges: Array<[number, number]>;
  score: number;
}

/**
 * ACL seam (out of scope for Plan 1): who is searching. Threaded through `searchPages`/`recentPages` so a
 * future permission filter can add an `AND <acl predicate>` to the WHERE clause without changing callers.
 */
export type Principal = { userId?: string | null };

export interface PageSearchInput {
  query: string;
  filters: SearchFilters;
  limit: number;
  principal?: Principal;
}

// ts_headline wraps matches in these (unlikely-in-prose) markers; we convert them to highlightRanges.
const SEL_START = "<<";
const SEL_STOP = ">>";

/**
 * Build a prefix tsquery for as-you-type search: each alphanumeric term becomes a `term:*` prefix
 * pattern, AND-joined (`frid` → `frid:*`, matching "friday"; `deploy frid` → `deploy:* & frid:*`).
 * Non-word characters are dropped, so the result is always valid to_tsquery input. Empty when the
 * input has no usable terms (caller skips the FTS pass).
 */
export function toPrefixTsQuery(query: string): string {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.map((t) => `${t}:*`).join(" & ");
}

/** Strip `<<…>>` markers from a ts_headline snippet, returning the clean text + matched char ranges. */
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
    documentId: row.document_id as string,
    title: row.title as string,
    bundleId: (row.bundle_id as string | null) ?? null,
    path: (row.path as string | null) ?? null,
    snippet,
    highlightRanges,
    score,
  };
}

export class PageRetrievalService {
  constructor(
    private readonly q: Queryable,
    private readonly cfg: RankingConfig = DEFAULT_RANKING
  ) {}

  /** Whole-page lexical search: grouped + title/body/recency-fused, with an optional trgm recall pass. */
  async searchPages(input: PageSearchInput): Promise<PageHit[]> {
    const { query, filters, limit } = input;
    // Prefix FTS for as-you-type matching; skip the FTS pass entirely when there are no usable terms.
    const tsq = toPrefixTsQuery(query);
    const primary = tsq === "" ? [] : await this.runPrimary(tsq, filters, limit);
    if (!this.cfg.trgmFallback || primary.length >= this.cfg.trgmThreshold) return primary;

    const seen = new Set(primary.map((h) => h.documentId));
    const fuzzy = (await this.runTrgm(query, filters, limit)).filter(
      (h) => !seen.has(h.documentId)
    );
    // Primary (relevance-ranked) hits stay on top; trgm-only hits fill the tail, sorted by similarity.
    return [...primary, ...fuzzy].slice(0, limit);
  }

  /** Zero-query state: the most-recently-updated pages (mirrors the Knowledge home "Recently edited"). */
  async recentPages(limit: number, filters: SearchFilters = {}): Promise<PageHit[]> {
    const params: unknown[] = [];
    const filterSql = this.filterSql(filters, params);
    params.push(limit);
    const { rows } = await this.q.query(
      `SELECT d.id AS document_id, d.title, d.bundle_id, d.path,
              left(d.plain_text, 200) AS snippet
       FROM knowledge_documents d
       WHERE d.active = true AND d.bundle_id IS NOT NULL AND d.path IS NOT NULL${filterSql}
       ORDER BY d.updated_at DESC, d.id
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
         SELECT c.document_id,
                max(ts_rank(c.tsv, q.tsq)) AS max_chunk_rank,
                (array_agg(c.content ORDER BY ts_rank(c.tsv, q.tsq) DESC))[1] AS best_chunk
         FROM knowledge_chunks c, q
         WHERE c.tsv @@ q.tsq
         GROUP BY c.document_id)
       SELECT d.id AS document_id, d.title, d.bundle_id, d.path,
              ( $2::float8 * ts_rank(d.title_tsv, q.tsq)
              + $3::float8 * COALESCE(ch.max_chunk_rank, 0) )
                * exp(-extract(epoch FROM (now() - d.updated_at)) * ln(2) / $4::float8) AS score,
              ts_headline('english', COALESCE(ch.best_chunk, d.plain_text), q.tsq,
                'StartSel=${SEL_START},StopSel=${SEL_STOP},MaxFragments=2,MinWords=5,MaxWords=18') AS snippet
       FROM knowledge_documents d
       CROSS JOIN q
       LEFT JOIN chunk_hits ch ON ch.document_id = d.id
       WHERE d.active = true AND d.bundle_id IS NOT NULL AND d.path IS NOT NULL
         AND (d.title_tsv @@ q.tsq OR ch.document_id IS NOT NULL)${filterSql}
       ORDER BY score DESC
       LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => rowToPageHit(r, Number((r as { score: number }).score)));
  }

  private async runTrgm(query: string, filters: SearchFilters, limit: number): Promise<PageHit[]> {
    // pg_trgm recall pass — `%` uses the title trigram index + the default 0.3 similarity threshold.
    const params: unknown[] = [query];
    const filterSql = this.filterSql(filters, params);
    params.push(limit);
    const { rows } = await this.q.query(
      `SELECT d.id AS document_id, d.title, d.bundle_id, d.path,
              left(d.plain_text, 200) AS snippet,
              similarity(d.title, $1) AS sim
       FROM knowledge_documents d
       WHERE d.active = true AND d.bundle_id IS NOT NULL AND d.path IS NOT NULL
         AND d.title % $1${filterSql}
       ORDER BY sim DESC, d.id
       LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => rowToPageHit(r, Number((r as { sim: number }).sim)));
  }

  /** Build the `{filterSql}` fragment (reuses docFilterConditions — `d.`-aliased, type/bundle/etc.). */
  private filterSql(filters: SearchFilters, params: unknown[]): string {
    const conds = docFilterConditions(filters, params);
    return conds.length > 0 ? ` AND ${conds.join(" AND ")}` : "";
  }
}
