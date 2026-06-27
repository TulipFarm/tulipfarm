import { Link, type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { BookText, FileText, Plus } from "lucide-react";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { getKnowledgeOverview } from "~/lib/knowledge-api";
import { pageHref } from "~/lib/page-href";

export const meta: MetaFunction = () => [{ title: "Knowledge · tulipfarm" }];

export async function clientLoader() {
  return getKnowledgeOverview(8);
}

// Landing pane for /knowledge — a real home: a grid of every space (page count + last activity) and
// a "Recently edited" list across all spaces. Falls back to a quiet welcome when there are no spaces.
export default function KnowledgeIndex() {
  const { spaces, recent } = useLoaderData<typeof clientLoader>();

  if (spaces.length === 0) {
    return (
      <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        <BookText className="size-8 text-muted-foreground" aria-hidden />
        <div className="flex flex-col gap-1">
          <h1 className="text-base font-bold text-foreground">Knowledge</h1>
          <p className="text-sm text-muted-foreground">
            Pick a page from the tree on the left, or create a new space to start a wiki.
          </p>
        </div>
        <NewSpaceLink />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8">
      <section className="flex flex-col gap-3">
        <header className="flex items-center justify-between">
          <h1 className="text-base font-bold text-foreground">Spaces</h1>
          <NewSpaceLink />
        </header>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {spaces.map((s) => (
            <li key={s.id}>
              <Link
                to={`/knowledge/spaces/${encodeURIComponent(s.id)}`}
                className="flex h-full cursor-pointer flex-col gap-2 rounded-sm border border-border bg-card px-4 py-3 transition-colors hover:border-primary/50 hover:bg-accent"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <BookText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  {s.name}
                </span>
                {s.description ? (
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {s.description}
                  </span>
                ) : null}
                <span className="mt-auto text-[0.7rem] text-muted-foreground">
                  {s.pageCount} {s.pageCount === 1 ? "page" : "pages"} · {timeAgo(s.lastActivity)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {recent.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-bold text-foreground">Recently edited</h2>
          <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
            {recent.map((p) => (
              <li key={p.pageId}>
                <Link
                  to={pageHref(p.pageId, p.path)}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-accent"
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{p.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{p.spaceName}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    · {timeAgo(p.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function NewSpaceLink() {
  return (
    <Link
      to="/knowledge/spaces/new"
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
    >
      <Plus className="size-3.5" aria-hidden />
      New space
    </Link>
  );
}

// "2026-06-22T…" → coarse relative label ("just now" / "5m ago" / "2d ago"). Empty for unparseable input.
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="knowledge" status={status} message={message} />;
}
