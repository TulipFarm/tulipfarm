import {
  type ClientLoaderFunctionArgs,
  Link,
  type MetaFunction,
  redirect,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { PageDetail } from "~/components/knowledge/page-detail";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { deletePage, getBacklinks, getPage, getSpace, listAllPages } from "~/lib/knowledge-api";
import { buildPageResolver, pageHref, pageSlug } from "~/lib/page-href";

export const meta: MetaFunction = () => [{ title: "Page · Knowledge · tulipfarm" }];

// Canonical page: addressed by the stable page UUID (`/knowledge/pages/<id>/<slug>`).
// The trailing slug splat is cosmetic and ignored — only `pageId` resolves. Space context (name +
// the `/knowledge/spaces/<id>` base for breadcrumb / back-link / tag links) is re-derived from the doc.
export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const pageId = params.pageId;
  if (!pageId) throw new ApiError(404, "missing page id");
  const doc = await getPage(pageId).catch(() => null);
  // Must be a live OKF page (active, in a space, with a path) — otherwise it has no page route.
  if (!doc?.active || !doc.spaceId || !doc.path) throw new ApiError(404, "page not found");
  // The slug is cosmetic + optional, but canonicalize it: a bare or stale slug redirects to
  // /knowledge/pages/<id>/<slug>. (No redirect when the path slugifies to empty.)
  const slug = pageSlug(doc.path);
  if (slug && (params["*"] ?? "") !== slug) throw redirect(pageHref(doc.id, doc.path));
  const [space, backlinks, pages] = await Promise.all([
    getSpace(doc.spaceId),
    getBacklinks(pageId)
      .then((r) => r.items)
      .catch(() => []),
    listAllPages().then((r) => r.items),
  ]);
  return { doc, path: doc.path, space, backlinks, pages };
}

export default function PageDetailRoute() {
  const { doc, path, space, backlinks, pages } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/knowledge/spaces/${encodeURIComponent(space.id)}`;
  const resolver = buildPageResolver(pages);

  async function onDelete() {
    setDeleting(true);
    setError(null);
    try {
      await deletePage(doc.id);
      window.dispatchEvent(new Event("okf:space-changed")); // refresh the persistent tree
      navigate(base);
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
      setDeleting(false);
    }
  }

  return (
    <article className="flex w-full flex-col gap-4 px-6 py-8">
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1 text-[0.625rem] font-medium uppercase tracking-[0.2em] text-muted-foreground"
      >
        <Link to={base} className="transition-colors hover:text-foreground">
          {space.name}
        </Link>
        {path.split("/").map((seg, i, all) => (
          <span key={all.slice(0, i + 1).join("/")} className="flex items-center gap-1">
            <span aria-hidden className="opacity-40">
              /
            </span>
            <span className={i === all.length - 1 ? "text-foreground" : ""}>{seg}</span>
          </span>
        ))}
      </nav>
      {error ? <p className="text-sm text-destructive">error: {error}</p> : null}
      <PageDetail
        spaceId={space.id}
        doc={doc}
        path={path}
        editTo={`/knowledge/pages/${encodeURIComponent(doc.id)}/edit`}
        onDelete={onDelete}
        deleting={deleting}
        backlinks={backlinks}
        resolver={resolver}
      />
    </article>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (error instanceof ApiError && error.status === 404) {
    return <NotFoundState section="knowledge" />;
  }
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="knowledge" status={status} message={message} />;
}
