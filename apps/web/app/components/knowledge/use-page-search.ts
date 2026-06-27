/*
 * Shared debounced page-search hook for the knowledge wiki (⌘K palette + sidebar box). Latest-wins
 * (a sequence guard drops out-of-order responses), dedupes by documentId, and on a blank query falls
 * back to the Knowledge "Recently edited" overview. Scope "space" passes the active bundleId so results
 * stay within the current space; "all" searches every space.
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
    documentId: r.documentId,
    title: r.title,
    bundleId: r.bundleId,
    path: r.path,
    snippet: "",
    highlightRanges: [],
    score: 0,
  };
}

function dedupe(hits: PageSearchHit[]): PageSearchHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    if (seen.has(h.documentId)) return false;
    seen.add(h.documentId);
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

export function usePageSearch(bundleId?: string | null): UsePageSearch {
  const [query, setQuery] = useState("");
  // The palette mounts once and `bundleId` changes on navigation (no remount), so the default must be
  // derived reactively — but an explicit user choice (override) sticks across routes.
  const [scopeOverride, setScopeOverride] = useState<SearchScope | null>(null);
  const scope: SearchScope = scopeOverride ?? (bundleId ? "space" : "all");
  const [results, setResults] = useState<PageSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const trimmed = query.trim();
  const isZeroQuery = trimmed === "";
  // Only scope to a bundle when "space" is selected AND we actually know the active bundle.
  const scopedBundle = scope === "space" && bundleId ? bundleId : undefined;

  useEffect(() => {
    const mySeq = seq.current + 1;
    seq.current = mySeq;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const hits =
          trimmed === ""
            ? (await getKnowledgeOverview(8)).recent.map(recentToHit)
            : await searchPages(trimmed, { bundleId: scopedBundle, limit: 10 });
        if (mySeq === seq.current) setResults(dedupe(hits));
      } catch {
        if (mySeq === seq.current) setResults([]);
      } finally {
        if (mySeq === seq.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed, scopedBundle]);

  return { query, setQuery, scope, setScope: setScopeOverride, results, loading, isZeroQuery };
}
