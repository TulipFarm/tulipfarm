import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { BundleForm } from "~/components/knowledge/bundle-form";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { type BundleInput, getBundle, updateBundle } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "Edit · Bundles · Knowledge · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw new ApiError(404, "missing bundle id");
  const bundle = await getBundle(id);
  return { bundle };
}

export default function BundleEdit() {
  const { bundle } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const detailPath = `/knowledge/bundles/${encodeURIComponent(bundle.id)}`;

  async function onSubmit(body: BundleInput) {
    setSubmitting(true);
    setFormError(null);
    try {
      await updateBundle(bundle.id, body);
      window.dispatchEvent(new Event("okf:bundle-changed")); // reflect the renamed space in the tree
      navigate(detailPath);
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 409
          ? "a bundle with that name already exists"
          : err instanceof Error
            ? err.message
            : "request failed";
      setFormError(message);
      setSubmitting(false);
    }
  }

  const crumbs = [
    { label: "knowledge", to: "/knowledge" },
    { label: bundle.name, to: detailPath },
    { label: "settings" },
  ];

  return (
    <ResourcePanel crumbs={crumbs}>
      <BundleForm
        mode="edit"
        initial={{ name: bundle.name, description: bundle.description }}
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
