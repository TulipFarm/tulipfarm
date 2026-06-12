import { type MetaFunction, useNavigate, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { DocForm } from "~/components/knowledge/doc-form";
import { writeErrorState } from "~/components/resource-form";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { createDocument, type DocumentInput } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "New · Documents · Knowledge · tulipfarm" }];

const command = "tulipfarm knowledge documents create";

export default function DocumentNew() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(body: DocumentInput) {
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const doc = await createDocument(body);
      navigate(`/knowledge/documents/${encodeURIComponent(doc.id)}`);
    } catch (err) {
      const next = writeErrorState(err);
      setFieldErrors(next.fieldErrors);
      setFormError(next.formError || null);
      setSubmitting(false);
    }
  }

  const crumbs = [
    { label: "knowledge", to: "/knowledge" },
    { label: "documents", to: "/knowledge/documents" },
    { label: "new" },
  ];

  return (
    <ResourcePanel crumbs={crumbs} command={command}>
      <DocForm
        mode="create"
        onSubmit={onSubmit}
        submitting={submitting}
        fieldErrors={fieldErrors}
        formError={formError}
        cancelTo="/knowledge/documents"
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
