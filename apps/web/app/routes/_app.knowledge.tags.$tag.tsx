import {
  type ClientLoaderFunctionArgs,
  Link,
  type MetaFunction,
  useLoaderData,
  useRouteError,
} from "@remix-run/react";
import { AgentAuthoredBadge } from "~/components/knowledge/agent-authored-badge";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { listPages } from "~/lib/knowledge-api";
import { pageHref } from "~/lib/page-href";

export const meta: MetaFunction = ({ params }) => [
  { title: `#${params.tag} · Knowledge · tulipfarm` },
];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  // Lowercase to match stored tags (normalized lowercase on save) under the case-sensitive server filter.
  const tag = params.tag?.toLowerCase();
  if (!tag) throw new ApiError(404, "missing tag");
  const page = await listPages(undefined, 50, [tag]);
  // Only wiki pages are navigable from here (legacy non-space docs have no detail route).
  const items = page.items.filter((d) => d.spaceId && d.path);
  return { tag, items };
}

export default function TagListing() {
  const { tag, items } = useLoaderData<typeof clientLoader>();
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8">
      <header className="flex flex-wrap items-center gap-2">
        <span className="tf-tag-chip">#{tag}</span>
        <h1 className="text-base font-bold text-foreground">tagged pages</h1>
      </header>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pages tagged #{tag}.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
          {items.map((d) => {
            const to = d.spaceId && d.path ? pageHref(d.id, d.path) : null;
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                {to ? (
                  <Link
                    to={to}
                    className="cursor-pointer text-primary underline underline-offset-2 hover:opacity-80"
                  >
                    {d.title}
                  </Link>
                ) : (
                  <span className="text-foreground">{d.title}</span>
                )}
                <AgentAuthoredBadge authorKind={d.authorKind} />
                {d.tags.length ? (
                  <span className="text-xs text-muted-foreground">
                    {d.tags.map((t) => `#${t}`).join(" ")}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        <Link
          to="/knowledge"
          className="cursor-pointer underline underline-offset-2 hover:text-foreground"
        >
          ← knowledge
        </Link>
      </p>
    </article>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="knowledge" status={status} message={message} />;
}
