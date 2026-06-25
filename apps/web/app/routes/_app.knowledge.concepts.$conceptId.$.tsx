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
import { ConceptDetail } from "~/components/knowledge/concept-detail";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { buildConceptResolver, conceptHref, conceptSlug } from "~/lib/concept-href";
import {
  deleteDocument,
  getBacklinks,
  getBundle,
  getDocument,
  listAllPages,
} from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "Concept · Knowledge · tulipfarm" }];

// Canonical concept page: addressed by the stable document UUID (`/knowledge/concepts/<id>/<slug>`).
// The trailing slug splat is cosmetic and ignored — only `conceptId` resolves. Bundle context (name +
// the `/knowledge/bundles/<id>` base for breadcrumb / back-link / tag links) is re-derived from the doc.
export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const conceptId = params.conceptId;
  if (!conceptId) throw new ApiError(404, "missing concept id");
  const doc = await getDocument(conceptId).catch(() => null);
  // Must be a live OKF concept (active, in a bundle, with a path) — otherwise it has no concept page.
  if (!doc?.active || !doc.bundleId || !doc.path) throw new ApiError(404, "concept not found");
  // The slug is cosmetic + optional, but canonicalize it: a bare or stale slug redirects to
  // /knowledge/concepts/<id>/<slug>. (No redirect when the path slugifies to empty.)
  const slug = conceptSlug(doc.path);
  if (slug && (params["*"] ?? "") !== slug) throw redirect(conceptHref(doc.id, doc.path));
  const [bundle, backlinks, pages] = await Promise.all([
    getBundle(doc.bundleId),
    getBacklinks(conceptId)
      .then((r) => r.items)
      .catch(() => []),
    listAllPages().then((r) => r.items),
  ]);
  return { doc, path: doc.path, bundle, backlinks, pages };
}

export default function ConceptDetailRoute() {
  const { doc, path, bundle, backlinks, pages } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/knowledge/bundles/${encodeURIComponent(bundle.id)}`;
  const resolver = buildConceptResolver(pages);

  async function onDelete() {
    setDeleting(true);
    setError(null);
    try {
      await deleteDocument(doc.id);
      window.dispatchEvent(new Event("okf:bundle-changed")); // refresh the persistent tree
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
          {bundle.name}
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
      <ConceptDetail
        bundleId={bundle.id}
        doc={doc}
        path={path}
        editTo={`/knowledge/concepts/${encodeURIComponent(doc.id)}/edit`}
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
