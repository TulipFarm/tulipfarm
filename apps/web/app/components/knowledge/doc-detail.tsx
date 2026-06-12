import { Link } from "@remix-run/react";
import { useState } from "react";
import { MarkdownView } from "~/components/markdown-view";
import { Button } from "~/components/ui/button";
import type { KnowledgeDocument } from "~/lib/knowledge-api";
import { IndexStatusBadge } from "./index-status-badge";

/*
 * Read-only document view: title + indexing badge + metadata, then the markdown content rendered via
 * MarkdownView. Edit links out; Delete uses a two-step inline confirm (no modal) before calling
 * `onDelete` (the route owns the soft-delete + navigation).
 */
export function DocDetail({
  doc,
  editTo,
  onDelete,
  deleting,
}: {
  doc: KnowledgeDocument;
  editTo: string;
  onDelete: () => void | Promise<void>;
  deleting: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-bold text-foreground">{doc.title}</h1>
        <IndexStatusBadge status={doc.indexingStatus ?? "pending"} />
        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={editTo}>Edit</Link>
          </Button>
          {confirming ? (
            <>
              <Button variant="destructive" size="sm" onClick={onDelete} disabled={deleting}>
                {deleting ? "deleting…" : "Confirm delete"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          )}
        </div>
      </div>

      <dl className="flex flex-col text-xs">
        <Meta label="domain" value={doc.domain ?? "—"} />
        <Meta label="tags" value={doc.tags.length ? doc.tags.join(", ") : "—"} />
        <Meta label="source" value={doc.source} />
        <Meta label="version" value={String(doc.version)} />
        <Meta label="updated" value={doc.updatedAt} />
      </dl>

      <div className="rounded-sm border border-border bg-background px-4 py-3">
        {doc.content.trim() ? (
          <MarkdownView>{doc.content}</MarkdownView>
        ) : (
          <p className="text-sm text-muted-foreground">(empty document)</p>
        )}
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 border-t border-border px-1 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{value}</dd>
    </div>
  );
}
