import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { PageForm } from "~/components/knowledge/page-form";
import { PageShell } from "~/components/page-shell";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { getSpace, navigateSpace, writePage } from "~/lib/knowledge-api";
import { isSynthesizedIndex } from "~/lib/okf-listing";
import { pageFormErrors } from "~/lib/page-form-errors";
import { pageHref } from "~/lib/page-href";

export const meta: MetaFunction = () => [{ title: "New page · Knowledge · tulipfarm" }];

export async function clientLoader({ params, request }: ClientLoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw new ApiError(404, "missing space id");
  const url = new URL(request.url);
  const seedPath = url.searchParams.get("path") ?? "";
  const parent = url.searchParams.get("parent") ?? "";
  const space = await getSpace(id);

  // "Edit front page" → author the reserved root index.md override: lock the path, open the raw tab,
  // and pre-fill the current front-page content.
  if (seedPath === "index") {
    const { listing } = await navigateSpace(id, "");
    // Only pre-fill when there's an authored front page; never freeze the synthesized contents.
    return {
      space,
      initialPath: "index",
      lockPath: true,
      initialTab: "raw" as const,
      initialContent: isSynthesizedIndex(listing) ? undefined : listing,
    };
  }

  const initialPath = parent ? `${parent.replace(/\/+$/, "")}/` : "";
  return { space, initialPath, lockPath: false, initialTab: undefined, initialContent: undefined };
}

export default function PageNew() {
  const { space, initialPath, lockPath, initialTab, initialContent } =
    useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<"path" | "content", string>>>({});

  const detailPath = `/knowledge/spaces/${encodeURIComponent(space.id)}`;

  async function onSubmit(path: string, content: string) {
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const result = await writePage(space.id, path, content);
      window.dispatchEvent(new Event("okf:space-changed")); // refresh the tree
      if ("override" in result) {
        navigate(detailPath);
      } else {
        navigate(pageHref(result.id, path)); // canonical uuid URL of the new page
      }
    } catch (err) {
      const mapped = pageFormErrors(err);
      setFormError(mapped.formError);
      setFieldErrors(mapped.fieldErrors);
      setSubmitting(false);
    }
  }

  const crumbs = [
    { label: "Knowledge", to: "/knowledge" },
    { label: space.name, to: detailPath },
    { label: initialPath === "index" ? "front page" : "new page" },
  ];

  return (
    <PageShell crumbs={crumbs} title={initialPath === "index" ? "Front page" : "New page"}>
      <PageForm
        mode="create"
        spaceId={space.id}
        initialPath={initialPath}
        lockPath={lockPath}
        initialTab={initialTab}
        initialContent={initialContent}
        onSubmit={onSubmit}
        submitting={submitting}
        formError={formError}
        fieldErrors={fieldErrors}
        cancelTo={detailPath}
      />
    </PageShell>
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
