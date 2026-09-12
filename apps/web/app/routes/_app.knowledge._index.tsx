import { type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { EmptyState } from "~/components/empty-state";
import { BookText, FileText, Plus, Waypoints } from "~/components/icons";
import { AgentAuthoredBadge } from "~/components/knowledge/agent-authored-badge";
import { VisibilityBadge } from "~/components/knowledge/visibility-badge";
import { PageShell } from "~/components/page-shell";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { ApiError } from "~/lib/api";
import { getKnowledgeOverview } from "~/lib/knowledge-api";
import { pageHref } from "~/lib/page-href";
import { timeAgo } from "~/lib/schema";

export const meta: MetaFunction = () => [{ title: "Knowledge · tulipfarm" }];

export async function clientLoader() {
  return getKnowledgeOverview(8);
}

export default function KnowledgeIndex() {
  const { spaces, recent } = useLoaderData<typeof clientLoader>();

  if (spaces.length === 0) {
    return (
      <PageShell title="Knowledge">
        <EmptyState
          section="knowledge"
          title="Keep useful knowledge in one place"
          hint="Keep guides, decisions and useful facts in pages. Group them in spaces so people and agents can find the context they need."
        >
          <Button asChild>
            <Link
              to={`/?draft=${encodeURIComponent(
                "Help me start our business knowledge. Ask what we need to document, then help me create a knowledge space and its first page using the facts I provide."
              )}`}
            >
              Start knowledge in chat
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/knowledge/spaces/new">Create a space manually</Link>
          </Button>
        </EmptyState>
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Knowledge"
      actions={
        <>
          <GraphLink />
          <NewSpaceLink />
        </>
      }
    >
      <div className="flex w-full max-w-3xl flex-col gap-8">
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">Spaces</h2>
          <ul className="divide-y divide-border">
            {spaces.map((s) => (
              <li key={s.id}>
                <Link
                  to={`/knowledge/spaces/${encodeURIComponent(s.id)}`}
                  className="flex min-w-0 cursor-pointer flex-col gap-1 rounded-md px-3 py-3 transition-colors hover:bg-accent focus-visible:bg-accent sm:flex-row sm:items-center sm:gap-4"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                      <BookText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate">{s.name}</span>
                    </span>
                    {s.description ? (
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {s.description}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {s.pageCount} {s.pageCount === 1 ? "page" : "pages"} · {timeAgo(s.lastActivity)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        {recent.length ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-foreground">Recently edited</h2>
            <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
              {recent.map((p) => (
                <li key={p.pageId}>
                  <Link
                    to={pageHref(p.pageId, p.path)}
                    className="flex min-w-0 cursor-pointer items-center gap-3 px-3 py-3 transition-colors hover:bg-accent"
                  >
                    <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">{p.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {p.spaceName} · {timeAgo(p.updatedAt)}
                      </span>
                    </span>
                    <AgentAuthoredBadge authorKind={p.authorKind} />
                    {p.visibility && p.visibility !== "business" ? (
                      <VisibilityBadge visibility={p.visibility} compact />
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </PageShell>
  );
}

function GraphLink() {
  return (
    <Button asChild size="sm" variant="ghost">
      <Link to="/knowledge/graph">
        <Waypoints className="size-3.5" aria-hidden />
        Graph
      </Link>
    </Button>
  );
}

function NewSpaceLink() {
  return (
    <Button asChild size="sm">
      <Link to="/knowledge/spaces/new">
        <Plus className="size-3.5" aria-hidden />
        New space
      </Link>
    </Button>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="knowledge" status={status} message={message} />;
}
