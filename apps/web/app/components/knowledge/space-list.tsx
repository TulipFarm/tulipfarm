import { Link } from "@remix-run/react";
import { Library } from "lucide-react";
import type { KnowledgeSpace } from "~/lib/knowledge-api";

/*
 * OKF spaces overview — a Confluence-style "spaces" card grid. Each card is the entry point into a
 * space's wiki workspace (tree + pages). cursor-pointer + ruby hover on every card.
 */
export function SpaceList({ items }: { items: KnowledgeSpace[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((b) => (
        <Link
          key={b.id}
          to={`/knowledge/spaces/${encodeURIComponent(b.id)}`}
          className="group flex cursor-pointer flex-col gap-1.5 rounded-md border border-border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent"
        >
          <div className="flex items-center gap-2">
            <Library className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="truncate font-medium text-foreground group-hover:text-primary">
              {b.name}
            </span>
          </div>
          {b.description ? (
            <p className="line-clamp-2 text-sm text-muted-foreground">{b.description}</p>
          ) : (
            <p className="text-sm text-muted-foreground/60">No description</p>
          )}
          <div className="mt-auto flex items-center gap-2 pt-2 text-xs text-muted-foreground">
            <span className="ml-auto">updated {b.updatedAt.slice(0, 10)}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
