import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { PageForm } from "~/components/knowledge/page-form";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { getPage, getSpace, writePage } from "~/lib/knowledge-api";
import { pageHref } from "~/lib/page-href";

export const meta: MetaFunction = () => [{ title: "Edit page · Knowledge · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const pageId = params.pageId;
  if (!pageId) throw new ApiError(404, "missing page id");
  const doc = await getPage(pageId).catch(() => null);
  if (!doc?.active || !doc.spaceId || !doc.path) throw new ApiError(404, "page not found");
  const space = await getSpace(doc.spaceId);
  return { space, doc, path: doc.path };
}

export default function PageEdit() {
  const { space, doc, path } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const spaceHome = `/knowledge/spaces/${encodeURIComponent(space.id)}`;
  const pagePath = pageHref(doc.id, path);

  async function onSubmit(_path: string, content: string) {
    setSubmitting(true);
    setFormError(null);
    try {
      // The path is fixed on edit (read-only field); re-post to the same path to replace content.
      await writePage(space.id, path, content);
      window.dispatchEvent(new Event("okf:space-changed")); // refresh the persistent tree
      navigate(pagePath);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "request failed");
      setSubmitting(false);
    }
  }

  const crumbs = [
    { label: "knowledge", to: "/knowledge" },
    { label: space.name, to: spaceHome },
    { label: doc.title, to: pagePath },
    { label: "edit" },
  ];

  return (
    <ResourcePanel crumbs={crumbs}>
      <PageForm
        mode="edit"
        spaceId={space.id}
        initialPath={path}
        initialContent={doc.content}
        onSubmit={onSubmit}
        submitting={submitting}
        formError={formError}
        cancelTo={pagePath}
      />
    </ResourcePanel>
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
