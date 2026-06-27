/*
 * ⌘K knowledge command palette. Opens on ⌘K/Ctrl-K or the `knowledge:open-search` window event (the
 * sidebar search box dispatches the latter). Drives the shared usePageSearch hook (server-side ranked,
 * so cmdk's own filter is off), groups hits by space, highlights the matched snippet, and navigates to
 * the page on select. A blank query shows recent pages; a scope toggle limits to the current space.
 */
import { useNavigate } from "@remix-run/react";
import { Command } from "cmdk";
import { type ReactNode, useEffect, useState } from "react";
import { conceptHref } from "~/lib/concept-href";
import { type KnowledgeBundle, listBundles, type PageSearchHit } from "~/lib/knowledge-api";
import { cn } from "~/lib/utils";
import { usePageSearch } from "./use-page-search";

export const OPEN_SEARCH_EVENT = "knowledge:open-search";

// Highlight the typed prefix at each word start. ts_headline marks whole lexemes server-side, but an
// as-you-type box should highlight only what the user typed ("fri" → "Fri" in "Friday"), so the ranges
// are computed client-side from the live query against the snippet text.
export function queryHighlightRanges(text: string, query: string): Array<[number, number]> {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    // Word-start prefix match (mirrors the `term:*` FTS), terms are alnum so safe to inline.
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${term}`, "giu");
    for (const m of text.matchAll(re)) {
      const idx = m.index ?? 0;
      ranges.push([idx, idx + term.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    const last = merged.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  const ranges = queryHighlightRanges(text, query);
  if (text === "" || ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], i) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={i} className="rounded-sm bg-primary/20 text-foreground">
        {text.slice(start, end)}
      </mark>
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function SearchSkeleton() {
  return (
    <div className="flex flex-col gap-1 p-1" data-testid="search-skeleton" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex flex-col gap-1.5 rounded-sm px-3 py-2">
          <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted/60" />
        </div>
      ))}
    </div>
  );
}

export function CommandPalette({ bundleId }: { bundleId?: string | null }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [bundleNames, setBundleNames] = useState<Map<string, string>>(new Map());
  const { query, setQuery, scope, setScope, results, loading, isZeroQuery } =
    usePageSearch(bundleId);

  // ⌘K / Ctrl-K toggles; the sidebar box opens via the shared event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SEARCH_EVENT, onOpen);
    };
  }, []);

  // Space-name lookup for the result group headers (small, cached once the palette first opens).
  useEffect(() => {
    if (!open || bundleNames.size > 0) return;
    listBundles()
      .then((p) => setBundleNames(new Map(p.items.map((b: KnowledgeBundle) => [b.id, b.name]))))
      .catch(() => {});
  }, [open, bundleNames.size]);

  const go = (hit: PageSearchHit) => {
    setOpen(false);
    navigate(conceptHref(hit.documentId, hit.path));
  };

  // Stable group order by first appearance (results already ranked).
  const groups: Array<{ bundleId: string | null; hits: PageSearchHit[] }> = [];
  for (const hit of results) {
    const g = groups.find((x) => x.bundleId === hit.bundleId);
    if (g) g.hits.push(hit);
    else groups.push({ bundleId: hit.bundleId, hits: [hit] });
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      shouldFilter={false}
      label="Search knowledge"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
    >
      <div className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
        <Command.Input
          value={query}
          onValueChange={setQuery}
          autoFocus
          placeholder="Search knowledge…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        {bundleId ? (
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5 text-xs">
            {(["space", "all"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={cn(
                  "cursor-pointer rounded-sm px-2 py-0.5 transition-colors",
                  scope === s
                    ? "bg-accent text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {s === "space" ? "This space" : "All spaces"}
              </button>
            ))}
          </div>
        ) : null}
        <Command.List className="min-h-0 flex-1 overflow-y-auto p-1">
          {loading && results.length === 0 ? (
            <SearchSkeleton />
          ) : (
            <>
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
                {isZeroQuery ? "No recent pages." : "No pages found."}
              </Command.Empty>
              {isZeroQuery && results.length > 0 ? (
                <div className="px-3 pt-2 pb-1 text-[0.625rem] font-medium uppercase tracking-[0.15em] text-muted-foreground">
                  Recently edited
                </div>
              ) : null}
              {groups.map((group) => (
                <Command.Group
                  key={group.bundleId ?? "none"}
                  heading={
                    !isZeroQuery ? (bundleNames.get(group.bundleId ?? "") ?? "Other") : undefined
                  }
                  className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[0.625rem] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.15em] [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {group.hits.map((hit) => (
                    <Command.Item
                      key={hit.documentId}
                      value={hit.documentId}
                      onSelect={() => go(hit)}
                      className="flex cursor-pointer flex-col gap-0.5 rounded-sm px-3 py-2 text-sm data-[selected=true]:bg-accent"
                    >
                      <span className="font-medium">{hit.title}</span>
                      {hit.snippet ? (
                        <span className="line-clamp-1 text-xs text-muted-foreground">
                          <HighlightedSnippet text={hit.snippet} query={query} />
                        </span>
                      ) : null}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </>
          )}
        </Command.List>
      </div>
    </Command.Dialog>
  );
}
