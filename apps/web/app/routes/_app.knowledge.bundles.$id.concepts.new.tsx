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
import { getBundle, navigateBundle, writeConcept } from "~/lib/knowledge-api";
import { isSynthesizedIndex } from "~/lib/okf-listing";

export const meta: MetaFunction = () => [{ title: "New page · Knowledge · tulipfarm" }];

export async function clientLoader({ params, request }: ClientLoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw new ApiError(404, "missing bundle id");
  const url = new URL(request.url);
  const seedPath = url.searchParams.get("path") ?? "";
  const parent = url.searchParams.get("parent") ?? "";
  const bundle = await getBundle(id);

  // "Edit front page" → author the reserved root index.md override: lock the path, open the raw tab,
  // and pre-fill the current front-page content.
  if (seedPath === "index") {
    const { listing } = await navigateBundle(id, "");
    // Only pre-fill when there's an authored front page; never freeze the synthesized contents.
    return {
      bundle,
      initialPath: "index",
      lockPath: true,
      initialTab: "raw" as const,
      initialContent: isSynthesizedIndex(listing) ? undefined : listing,
    };
  }

  const initialPath = parent ? `${parent.replace(/\/+$/, "")}/` : "";
  return { bundle, initialPath, lockPath: false, initialTab: undefined, initialContent: undefined };
}

export default function ConceptNew() {
  const { bundle, initialPath, lockPath, initialTab, initialContent } =
    useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const detailPath = `/knowledge/bundles/${encodeURIComponent(bundle.id)}`;

  async function onSubmit(path: string, content: string) {
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await writeConcept(bundle.id, path, content);
      window.dispatchEvent(new Event("okf:bundle-changed")); // refresh the tree
      if ("override" in result) {
        navigate(detailPath);
      } else {
        navigate(conceptHref(result.id, path)); // canonical uuid URL of the new concept
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "request failed");
      setSubmitting(false);
    }
  }

  const crumbs = [
    { label: "knowledge", to: "/knowledge" },
    { label: bundle.name, to: detailPath },
    { label: initialPath === "index" ? "front page" : "new page" },
  ];

  return (
    <ResourcePanel crumbs={crumbs}>
      <ConceptForm
        mode="create"
        bundleId={bundle.id}
        initialPath={initialPath}
        lockPath={lockPath}
        initialTab={initialTab}
        initialContent={initialContent}
        onSubmit={onSubmit}
        submitting={submitting}
        formError={formError}
        cancelTo={detailPath}
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
