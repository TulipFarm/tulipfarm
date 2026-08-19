import { type MetaFunction, useNavigate, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { SpaceForm } from "~/components/knowledge/space-form";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { createSpace, type SpaceInput } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "New · Spaces · Knowledge · tulipfarm" }];

export default function SpaceNew() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(body: SpaceInput) {
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const b = await createSpace(body);
      window.dispatchEvent(new Event("okf:space-changed")); // surface the new space in the tree
      navigate(`/knowledge/spaces/${encodeURIComponent(b.id)}`);
    } catch (err) {
      // A taken name is a problem with the name, so it belongs against the name field rather than
      // in a banner the reader has to map back to an input themselves.
      if (err instanceof ApiError && err.status === 409) {
        setFieldErrors({ name: "a space with that name already exists" });
      } else {
        setFormError(err instanceof Error ? err.message : "request failed");
      }
      setSubmitting(false);
    }
  }

  const crumbs = [{ label: "knowledge", to: "/knowledge" }, { label: "new space" }];

  return (
    <ResourcePanel crumbs={crumbs}>
      <SpaceForm
        mode="create"
        onSubmit={onSubmit}
        submitting={submitting}
        fieldErrors={fieldErrors}
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
