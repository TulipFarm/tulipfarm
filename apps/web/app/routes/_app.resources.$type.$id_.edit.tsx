import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { ResourceForm, writeErrorState } from "~/components/resource-form";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError, getRecord, listResourceTypes, updateRecord } from "~/lib/api";
import { type FieldDescriptor, formFields, parseSchema } from "~/lib/schema";

export const meta: MetaFunction = () => [{ title: "Edit · Resources · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const type = params.type;
  const id = params.id;
  if (!type || !id) throw new ApiError(404, "missing resource type or id");

  const types = await listResourceTypes();
  const summary = types.find((t) => t.name === type);
  if (!summary) throw new ApiError(404, `resource type not found: ${type}`);

  const parsed = parseSchema(summary.schema);
  const fields: FieldDescriptor[] = parsed.ok ? formFields(parsed.schema) : [];
  const schemaError = parsed.ok ? undefined : parsed.error;

  const record = await getRecord(type, id);
  return { type, id, record, fields, schemaError };
}

export default function ResourceEdit() {
  const { type, id, record, fields, schemaError } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const detailPath = `/resources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;

  async function onSubmit(values: Record<string, unknown>) {
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);
    try {
      await updateRecord(type, id, record.version, values);
      navigate(detailPath);
    } catch (err) {
      const next = writeErrorState(err);
      setFieldErrors(next.fieldErrors);
      setFormError(next.formError || null);
      setSubmitting(false);
    }
  }

  const crumbs = [
    { label: "resources", to: "/resources" },
    { label: type, to: `/resources/${encodeURIComponent(type)}` },
    { label: record.id, to: detailPath },
    { label: "edit" },
  ];

  return (
    <ResourcePanel crumbs={crumbs}>
      {schemaError ? (
        <p className="text-destructive">error: schema parse failed — {schemaError}</p>
      ) : (
        <ResourceForm
          fields={fields}
          mode="edit"
          initial={record}
          onSubmit={onSubmit}
          submitting={submitting}
          fieldErrors={fieldErrors}
          formError={formError}
          cancelTo={detailPath}
        />
      )}
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (error instanceof ApiError && error.status === 404) {
    return <NotFoundState section="resources" />;
  }
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="resources" status={status} message={message} />;
}
