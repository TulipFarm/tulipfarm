import { Link } from "@remix-run/react";
import { type FormEvent, useState } from "react";
import { Button } from "~/components/ui/button";
import type { KnowledgeCollection, KnowledgeDocument } from "~/lib/knowledge-api";

/*
 * Collection drill-in: meta + member documents with add/remove. Presentational — the route resolves
 * member ids to documents, owns the mutations, and revalidates. Membership add is a raw document-id
 * input (no autocomplete in V1).
 */
export function CollectionDetail({
  collection,
  documents,
  editTo,
  onAdd,
  onRemove,
  busy,
}: {
  collection: KnowledgeCollection;
  documents: KnowledgeDocument[];
  editTo: string;
  onAdd: (documentId: string) => void | Promise<void>;
  onRemove: (documentId: string) => void | Promise<void>;
  busy: boolean;
}) {
  const [docId, setDocId] = useState("");

  function handleAdd(e: FormEvent) {
    e.preventDefault();
    const id = docId.trim();
    if (!id) return;
    onAdd(id);
    setDocId("");
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-bold text-foreground">{collection.name}</h1>
        <div className="ml-auto">
          <Button asChild variant="outline" size="sm">
            <Link to={editTo}>Edit</Link>
          </Button>
        </div>
      </div>

      {collection.description ? (
        <p className="text-sm text-muted-foreground">{collection.description}</p>
      ) : null}

      <div className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          <span className="text-primary">[</span>documents<span className="text-primary">]</span>{" "}
          <span className="tabular-nums">{documents.length}</span>
        </p>
        {documents.length === 0 ? (
          <p className="text-muted-foreground">0 results</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
            {documents.map((d) => (
              <li key={d.id} className="flex items-center gap-2 px-3 py-2">
                <Link
                  to={`/knowledge/documents/${encodeURIComponent(d.id)}`}
                  className="text-primary hover:underline"
                >
                  {d.title}
                </Link>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => onRemove(d.id)}
                  disabled={busy}
                >
                  remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={handleAdd} className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor="addDocId" className="text-xs text-muted-foreground">
            add document by id
          </label>
          <input
            id="addDocId"
            className="w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
            placeholder="document uuid"
          />
        </div>
        <Button type="submit" variant="outline" disabled={busy || docId.trim() === ""}>
          Add
        </Button>
      </form>
    </div>
  );
}
