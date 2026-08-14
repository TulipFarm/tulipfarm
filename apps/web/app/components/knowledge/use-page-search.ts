/*
 * Latest-wins (a sequence guard drops out-of-order responses), dedupes by pageId, and on a
 * blank query falls back to the Knowledge "Recently edited" overview.
 */
import { useEffect, useRef, useState } from "react";
import {
  getKnowledgeOverview,
  type PageSearchHit,
  type RecentPage,
  searchPages,
} from "~/lib/knowledge-api";

export type SearchScope = "space" | "all";

const DEBOUNCE_MS = 150;

function recentToHit(r: RecentPage): PageSearchHit {
  return {
    pageId: r.pageId,
    title: r.title,
    spaceId: r.spaceId,
    path: r.path,
    snippet: "",
    highlightRanges: [],
    score: 0,
  };
}

function dedupe(hits: PageSearchHit[]): PageSearchHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    if (seen.has(h.pageId)) return false;
    seen.add(h.pageId);
    return true;
  });
}

export interface UsePageSearch {
  query: string;
  setQuery: (q: string) => void;
  scope: SearchScope;
  setScope: (s: SearchScope) => void;
  results: PageSearchHit[];
  loading: boolean;
  isZeroQuery: boolean;
}

export function usePageSearch(spaceId?: string | null): UsePageSearch {
  const [query, setQuery] = useState("");
  const [scopeOverride, setScopeOverride] = useState<SearchScope | null>(null);
  const scope: SearchScope = scopeOverride ?? (spaceId ? "space" : "all");
  const [results, setResults] = useState<PageSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const trimmed = query.trim();
  const isZeroQuery = trimmed === "";
  const scopedSpace = scope === "space" && spaceId ? spaceId : undefined;

  useEffect(() => {
    const mySeq = seq.current + 1;
    seq.current = mySeq;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const hits =
          trimmed === ""
            ? (await getKnowledgeOverview(8)).recent.map(recentToHit)
            : await searchPages(trimmed, { spaceId: scopedSpace, limit: 10 });
        if (mySeq === seq.current) setResults(dedupe(hits));
      } catch {
        if (mySeq === seq.current) setResults([]);
      } finally {
        if (mySeq === seq.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed, scopedSpace]);

  return { query, setQuery, scope, setScope: setScopeOverride, results, loading, isZeroQuery };
}
