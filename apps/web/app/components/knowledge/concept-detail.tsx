import { Link } from "@remix-run/react";
import { FileText, History, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BacklinksPanel } from "~/components/knowledge/backlinks-panel";
import { HistoryDrawer } from "~/components/knowledge/history-panel";
import { MarkdownView } from "~/components/markdown-view";
import { Button } from "~/components/ui/button";
import type { ConceptResolver } from "~/lib/concept-href";
import type { Backlink, KnowledgeDocument } from "~/lib/knowledge-api";
import { parseOkf } from "~/lib/okf";
import { rewriteWikiLinks } from "~/lib/okf-listing";

/*
 * Read-only OKF concept view: a document-style page — title + a single metadata line (type · updated ·
 * resource · tags), the markdown body rendered as prose (links rewritten to SPA routes, `#tag` → chips),
 * then a "Linked from" backlinks footer. Edit links out; the `⋯` overflow menu holds History (opens a
 * right-side drawer) and Delete (two-step confirm; the route owns the delete). An empty body shows a
 * placeholder with an Edit affordance.
 */
export function ConceptDetail({
  bundleId,
  doc,
  path,
  editTo,
  onDelete,
  deleting,
  backlinks,
  resolver,
}: {
  bundleId: string;
  doc: KnowledgeDocument;
  path: string;
  editTo: string;
  onDelete: () => void | Promise<void>;
  deleting: boolean;
  backlinks: Backlink[];
  resolver: ConceptResolver;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const body = useMemo(
    () => rewriteWikiLinks(parseOkf(doc.content).body, bundleId, resolver),
    [doc.content, bundleId, resolver]
  );
  const httpResource = doc.resource && /^https?:\/\//i.test(doc.resource);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{doc.title}</h1>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-muted-foreground">
            <span>Updated {formatUpdated(doc.updatedAt)}</span>
            {doc.resource ? (
              <>
                <Dot />
                {httpResource ? (
                  // Only http(s) resources are clickable — guards against `javascript:`/`data:` hrefs
                  // (the resource field is author-controlled and also set by bundle import).
                  <a
                    href={doc.resource}
                    target="_blank"
                    rel="noreferrer"
                    className="cursor-pointer truncate text-primary underline underline-offset-2 hover:opacity-80"
                  >
                    {doc.resource}
                  </a>
                ) : (
                  <span className="truncate">{doc.resource}</span>
                )}
              </>
            ) : null}
            {doc.tags.length ? (
              <>
                <Dot />
                <span className="flex flex-wrap gap-1.5">
                  {doc.tags.map((t) => (
                    <Link
                      key={t}
                      to={`/knowledge/tags/${encodeURIComponent(t)}`}
                      className="tf-tag-chip cursor-pointer"
                    >
                      #{t}
                    </Link>
                  ))}
                </span>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button asChild variant="outline" size="sm" className="cursor-pointer">
            <Link to={editTo}>
              <Pencil aria-hidden />
              Edit
            </Link>
          </Button>
          <MoreMenu
            onDelete={onDelete}
            deleting={deleting}
            onOpenHistory={() => setHistoryOpen(true)}
          />
        </div>
      </header>

      {body.trim() ? (
        <MarkdownView wikiLinks>{body}</MarkdownView>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-sm border border-dashed border-border py-14 text-center">
          <FileText className="size-7 text-muted-foreground/40" aria-hidden />
          <p className="text-sm text-muted-foreground">This page has no content yet.</p>
          <Button asChild variant="outline" size="sm" className="cursor-pointer">
            <Link to={editTo}>
              <Pencil aria-hidden />
              Add content
            </Link>
          </Button>
        </div>
      )}

      {backlinks.length ? (
        <div className="border-t border-border pt-5">
          <BacklinksPanel backlinks={backlinks} />
        </div>
      ) : null}

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        documentId={doc.id}
        bundleId={bundleId}
        path={path}
        resolver={resolver}
        currentContent={doc.content}
        currentUpdatedAt={doc.updatedAt}
      />
    </div>
  );
}

// A `⋯` overflow menu holding the destructive Delete action behind a two-step confirm. Self-contained
// (the app has no dropdown primitive): a relative-positioned panel that closes on outside-click or Escape.
function MoreMenu({
  onDelete,
  deleting,
  onOpenHistory,
}: {
  onDelete: () => void | Promise<void>;
  deleting: boolean;
  onOpenHistory: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setConfirming(false);
    };
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const itemClass =
    "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm disabled:cursor-default disabled:opacity-50";

  return (
    <div ref={ref} className="relative">
      <Button
        variant="outline"
        size="icon"
        className="size-8 cursor-pointer"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal aria-hidden />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 flex min-w-44 flex-col gap-0.5 rounded-sm border border-border bg-card p-1 shadow-md"
        >
          {confirming ? (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={deleting}
                onClick={() => void onDelete()}
                className={`${itemClass} text-destructive hover:bg-destructive/10`}
              >
                <Trash2 className="size-4" aria-hidden />
                {deleting ? "Deleting…" : "Confirm delete"}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={deleting}
                onClick={() => setConfirming(false)}
                className={`${itemClass} text-muted-foreground hover:bg-accent`}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onOpenHistory();
                  setOpen(false);
                }}
                className={`${itemClass} text-foreground hover:bg-accent`}
              >
                <History className="size-4" aria-hidden />
                History
              </button>
              <div aria-hidden className="my-0.5 h-px bg-border" />
              <button
                type="button"
                role="menuitem"
                onClick={() => setConfirming(true)}
                className={`${itemClass} text-destructive hover:bg-destructive/10`}
              >
                <Trash2 className="size-4" aria-hidden />
                Delete
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-border">
      ·
    </span>
  );
}

// "2026-06-22T…" → "Jun 22, 2026". Falls back to the raw date slice if it can't be parsed.
function formatUpdated(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
