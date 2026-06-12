import { type MetaFunction, useNavigate, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { CollectionForm } from "~/components/knowledge/collection-form";
import { writeErrorState } from "~/components/resource-form";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { type CollectionInput, createCollection } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "New · Collections · Knowledge · tulipfarm" }];

const command = "tulipfarm knowledge collections create";

export default function CollectionNew() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(body: CollectionInput) {
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const c = await createCollection(body);
      navigate(`/knowledge/collections/${encodeURIComponent(c.id)}`);
    } catch (err) {
      const next = writeErrorState(err);
      setFieldErrors(next.fieldErrors);
      setFormError(next.formError || null);
      setSubmitting(false);
    }
  }

  const crumbs = [
    { label: "knowledge", to: "/knowledge" },
    { label: "collections", to: "/knowledge/collections" },
    { label: "new" },
  ];

  return (
    <ResourcePanel crumbs={crumbs} command={command}>
      <CollectionForm
        mode="create"
        onSubmit={onSubmit}
        submitting={submitting}
        fieldErrors={fieldErrors}
        formError={formError}
        cancelTo="/knowledge/collections"
      />
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="knowledge" command={command} status={status} message={message} />;
}
