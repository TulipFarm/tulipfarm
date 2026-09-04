import { useRevalidator } from "@remix-run/react";
import { useCallback, useEffect, useState } from "react";
import { MarkdownView } from "~/components/markdown-view";
import { Button } from "~/components/ui/button";
import { Sheet } from "~/components/ui/sheet";
import { type KnowledgeRevision, listRevisions, writePage } from "~/lib/knowledge-api";
import { type OkfFields, parseOkf } from "~/lib/okf";
import { rewriteWikiLinks } from "~/lib/okf-listing";
import type { PageResolver } from "~/lib/page-href";

/* Restore re-POSTs old content through `writePage`, creating a fresh revision before rollback. */
export function HistoryDrawer({
  open,
  onClose,
  pageId,
  spaceId,
  path,
  resolver,
  currentContent,
  currentUpdatedAt,
}: {
  open: boolean;
  onClose: () => void;
  pageId: string;
  spaceId: string;
  path: string;
  resolver: PageResolver;
  /** The live doc — shown as the "Current" entry at the top, above the past revisions. */
  currentContent: string;
  currentUpdatedAt: string;
}) {
  const revalidator = useRevalidator();
  const [revs, setRevs] = useState<KnowledgeRevision[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await listRevisions(pageId);
      setRevs(r.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load history");
    } finally {
      setLoading(false);
    }
  }, [pageId]);

  // Load fresh whenever the drawer opens; clear on close so a reopen re-fetches the latest revisions.
  useEffect(() => {
    if (open) void load();
    else setRevs(null);
  }, [open, load]);

  async function restore(rev: KnowledgeRevision) {
    setRestoring(true);
    setError(null);
    try {
      await writePage(spaceId, path, rev.content);
      window.dispatchEvent(new Event("okf:space-changed"));
      setConfirmId(null);
      setPreviewId(null);
      await load(); // the restore itself snapshotted a new revision, refresh the list
      revalidator.revalidate(); // pull the restored content into the read view
    } catch (e) {
      setError(e instanceof Error ? e.message : "restore failed");
    } finally {
      setRestoring(false);
    }
  }

  // Newest-first: the live version, then each saved revision. Each carries its parsed OKF fields so we
  // can both render its title and diff it against the version below it.
  const items = [
    {
      id: "current",
      label: "Current",
      when: currentUpdatedAt,
      fields: parseOkf(currentContent),
      isCurrent: true,
      reason: null as string | null,
      rev: null as KnowledgeRevision | null,
    },
    ...(revs ?? []).map((rev) => ({
      id: rev.id,
      label: `#${rev.revisionNumber}`,
      when: rev.createdAt,
      fields: parseOkf(rev.content),
      isCurrent: false,
      reason: rev.reason,
      rev,
    })),
  ];

  return (
    <Sheet open={open} onClose={onClose} title="History">
      {error ? <p className="text-xs text-destructive">error: {error}</p> : null}
      <ul className="flex flex-col gap-2">
        {items.map((it, i) => {
          const isPreview = previewId === it.id;
          const changes = summarizeChanges(it.fields, items[i + 1]?.fields); // vs the older version
          return (
            <li
              key={it.id}
              className="flex flex-col gap-1 border-border border-b pb-2 last:border-0"
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setPreviewId(isPreview ? null : it.id)}
                  className="cursor-pointer text-left text-primary underline underline-offset-2 hover:opacity-80"
                >
                  {it.label} · {formatWhen(it.when)}
                </button>
                {it.isCurrent ? (
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                    current
                  </span>
                ) : confirmId === it.id ? (
                  <span className="flex items-center gap-1.5">
                    <Button
                      variant="destructive"
                      size="sm"
                      className="cursor-pointer"
                      onClick={() => it.rev && restore(it.rev)}
                      disabled={restoring}
                    >
                      {restoring ? "restoring…" : "Confirm restore"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="cursor-pointer"
                      onClick={() => setConfirmId(null)}
                      disabled={restoring}
                    >
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="cursor-pointer"
                    onClick={() => setConfirmId(it.id)}
                  >
                    Restore
                  </Button>
                )}
              </div>
              {it.fields.title ? (
                <span className="text-sm font-medium text-foreground">{it.fields.title}</span>
              ) : null}
              {changes.length ? (
                <ul className="flex flex-col gap-0.5">
                  {changes.map((c) => (
                    <li key={c} className="text-[0.65rem] text-muted-foreground">
                      {c}
                    </li>
                  ))}
                </ul>
              ) : null}
              {it.reason ? (
                <span className="text-[0.65rem] text-muted-foreground/70">reason: {it.reason}</span>
              ) : null}
              {isPreview ? (
                <div className="rounded-sm border border-border bg-muted/30 px-3 py-2">
                  {it.fields.title ? (
                    <p className="mb-2 font-bold text-foreground">{it.fields.title}</p>
                  ) : null}
                  <MarkdownView wikiLinks>
                    {rewriteWikiLinks(it.fields.body, spaceId, resolver)}
                  </MarkdownView>
                </div>
              ) : null}
            </li>
          );
        })}
        {loading ? <li className="text-xs text-muted-foreground">loading…</li> : null}
        {!loading && revs && revs.length === 0 ? (
          <li className="text-xs text-muted-foreground">No earlier versions.</li>
        ) : null}
      </ul>
    </Sheet>
  );
}

// Human-readable summary of what a version changed relative to the one below it (the older version).
// Empty for the earliest version (no `prev`).
function summarizeChanges(cur: OkfFields, prev?: OkfFields): string[] {
  if (!prev) return [];
  const out: string[] = [];
  if (cur.title !== prev.title) {
    out.push(`Title: ${prev.title || "untitled"} → ${cur.title || "untitled"}`);
  }
  if (cur.body !== prev.body) out.push("Body edited");
  if (cur.resource !== prev.resource) out.push("Resource changed");
  if (cur.tags.join("\u0000") !== prev.tags.join("\u0000")) out.push("Tags changed");
  return out;
}

// "2026-06-22T14:30…" → "Jun 22, 02:30 PM". Falls back to a trimmed ISO slice when unparseable.
function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
