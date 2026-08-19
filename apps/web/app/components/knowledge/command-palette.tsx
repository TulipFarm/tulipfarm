import { useNavigate } from "@remix-run/react";
import { Command } from "cmdk";
import { type ReactNode, useEffect, useState } from "react";
import { type KnowledgeSpace, listSpaces, type PageSearchHit } from "~/lib/knowledge-api";
import { pageHref } from "~/lib/page-href";
import { cn } from "~/lib/utils";
import { AgentAuthoredBadge } from "./agent-authored-badge";
import { usePageSearch } from "./use-page-search";

export const OPEN_SEARCH_EVENT = "knowledge:open-search";

export function queryHighlightRanges(text: string, query: string): Array<[number, number]> {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
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

export function CommandPalette({ spaceId }: { spaceId?: string | null }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [spaceNames, setSpaceNames] = useState<Map<string, string>>(new Map());
  const { query, setQuery, scope, setScope, results, loading, isZeroQuery } =
    usePageSearch(spaceId);

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

  useEffect(() => {
    if (!open || spaceNames.size > 0) return;
    listSpaces()
      .then((p) => setSpaceNames(new Map(p.items.map((b: KnowledgeSpace) => [b.id, b.name]))))
      .catch(() => {});
  }, [open, spaceNames.size]);

  const go = (hit: PageSearchHit) => {
    setOpen(false);
    navigate(pageHref(hit.pageId, hit.path));
  };

  const groups: Array<{ spaceId: string | null; hits: PageSearchHit[] }> = [];
  for (const hit of results) {
    const g = groups.find((x) => x.spaceId === hit.spaceId);
    if (g) g.hits.push(hit);
    else groups.push({ spaceId: hit.spaceId, hits: [hit] });
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
        {spaceId ? (
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
                  key={group.spaceId ?? "none"}
                  heading={
                    !isZeroQuery ? (spaceNames.get(group.spaceId ?? "") ?? "Other") : undefined
                  }
                  className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[0.625rem] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.15em] [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {group.hits.map((hit) => (
                    <Command.Item
                      key={hit.pageId}
                      value={hit.pageId}
                      onSelect={() => go(hit)}
                      className="flex cursor-pointer flex-col gap-0.5 rounded-sm px-3 py-2 text-sm data-[selected=true]:bg-accent"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium">{hit.title}</span>
                        <AgentAuthoredBadge authorKind={hit.authorKind} compact />
                      </span>
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
