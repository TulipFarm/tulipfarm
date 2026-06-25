import { type MetaFunction, useNavigate, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { BundleForm } from "~/components/knowledge/bundle-form";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { type BundleInput, createBundle } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "New · Bundles · Knowledge · tulipfarm" }];

export default function BundleNew() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(body: BundleInput) {
    setSubmitting(true);
    setFormError(null);
    try {
      const b = await createBundle(body);
      window.dispatchEvent(new Event("okf:bundle-changed")); // surface the new space in the tree
      navigate(`/knowledge/bundles/${encodeURIComponent(b.id)}`);
    } catch (err) {
      // 409 here means the name is taken — surface the server message as a banner.
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

  const crumbs = [{ label: "knowledge", to: "/knowledge" }, { label: "new space" }];

  return (
    <ResourcePanel crumbs={crumbs}>
      <BundleForm
        mode="create"
        onSubmit={onSubmit}
        submitting={submitting}
        formError={formError}
        cancelTo="/knowledge"
      />
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="knowledge" status={status} message={message} />;
}
