import { Link } from "@remix-run/react";
import type { Backlink } from "~/lib/knowledge-api";
import { pageHref } from "~/lib/page-href";

/*
 * "Linked from" panel — the inbound links to the current page (same- and cross-space), computed
 * server-side by reverse-querying the link graph. Renders nothing when there are no backlinks.
 */
export function BacklinksPanel({ backlinks }: { backlinks: Backlink[] }) {
  if (backlinks.length === 0) return null;
  return (
    <aside className="rounded-sm border border-border bg-background px-3 py-2">
      <h2 className="mb-2 text-[0.625rem] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
        Linked from
      </h2>
      <ul className="flex flex-col gap-1.5">
        {backlinks.map((b) => {
          const to = b.path
            ? pageHref(b.sourceId, b.path)
            : `/knowledge/spaces/${encodeURIComponent(b.spaceId)}`;
          return (
            <li key={b.sourceId} className="flex items-center justify-between gap-2 text-xs">
              <Link
                to={to}
                className="cursor-pointer truncate text-primary underline underline-offset-2 hover:opacity-80"
              >
                {b.title}
              </Link>
              <span className="shrink-0 text-[0.65rem] uppercase tracking-[0.1em] text-muted-foreground">
                {b.spaceName}
              </span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
