import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { ConceptForm } from "~/components/knowledge/concept-form";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { conceptHref } from "~/lib/concept-href";
import { getBundle, getDocument, writeConcept } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "Edit concept · Knowledge · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const conceptId = params.conceptId;
  if (!conceptId) throw new ApiError(404, "missing concept id");
  const doc = await getDocument(conceptId).catch(() => null);
  if (!doc?.active || !doc.bundleId || !doc.path) throw new ApiError(404, "concept not found");
  const bundle = await getBundle(doc.bundleId);
  return { bundle, doc, path: doc.path };
}

export default function ConceptEdit() {
  const { bundle, doc, path } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const bundleHome = `/knowledge/bundles/${encodeURIComponent(bundle.id)}`;
  const conceptPath = conceptHref(doc.id, path);

  async function onSubmit(_path: string, content: string) {
    setSubmitting(true);
    setFormError(null);
    try {
      // The path is fixed on edit (read-only field); re-post to the same path to replace content.
      await writeConcept(bundle.id, path, content);
      window.dispatchEvent(new Event("okf:bundle-changed")); // refresh the persistent tree
      navigate(conceptPath);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "request failed");
      setSubmitting(false);
    }
  }

  const crumbs = [
    { label: "knowledge", to: "/knowledge" },
    { label: bundle.name, to: bundleHome },
    { label: doc.title, to: conceptPath },
    { label: "edit" },
  ];

  return (
    <ResourcePanel crumbs={crumbs}>
      <ConceptForm
        mode="edit"
        bundleId={bundle.id}
        initialPath={path}
        initialContent={doc.content}
        onSubmit={onSubmit}
        submitting={submitting}
        formError={formError}
        cancelTo={conceptPath}
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
