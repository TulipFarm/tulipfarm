import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { PageShell } from "~/components/page-shell";
import { ResourceForm, writeErrorState } from "~/components/resource-form";
import { ErrorState } from "~/components/states";
import { ApiError, createRecord, listResourceTypes } from "~/lib/api";
import { type FieldDescriptor, formFields, parseSchema } from "~/lib/schema";

export const meta: MetaFunction = () => [{ title: "New · Resources · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const type = params.type;
  if (!type) throw new ApiError(404, "missing resource type");

  // No single-type schema endpoint exists — fetch the collection and pick this type's schema.
  const types = await listResourceTypes();
  const summary = types.find((t) => t.name === type);
  if (!summary) throw new ApiError(404, `resource type not found: ${type}`);

  const parsed = parseSchema(summary.schema);
  const fields: FieldDescriptor[] = parsed.ok ? formFields(parsed.schema) : [];
  const schemaError = parsed.ok ? undefined : parsed.error;
  return { type, fields, schemaError };
}

export default function ResourceCreate() {
  const { type, fields, schemaError } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(values: Record<string, unknown>) {
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const record = await createRecord(type, values);
      navigate(`/resources/${encodeURIComponent(type)}/${encodeURIComponent(record.id)}`);
    } catch (err) {
      const next = writeErrorState(err);
      setFieldErrors(next.fieldErrors);
      setFormError(next.formError || null);
      setSubmitting(false);
    }
  }

  const crumbs = [
    { label: "Resources", to: "/resources" },
    { label: type, to: `/resources/${encodeURIComponent(type)}` },
    { label: "new" },
  ];

  return (
    <PageShell crumbs={crumbs} title={`New ${type} record`}>
      {schemaError ? (
        <p className="text-destructive">error: schema parse failed, {schemaError}</p>
      ) : (
        <ResourceForm
          fields={fields}
          mode="create"
          onSubmit={onSubmit}
          submitting={submitting}
          fieldErrors={fieldErrors}
          formError={formError}
          cancelTo={`/resources/${encodeURIComponent(type)}`}
        />
      )}
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="resources" status={status} message={message} />;
}
