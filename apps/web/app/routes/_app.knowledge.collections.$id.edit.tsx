import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { CollectionForm } from "~/components/knowledge/collection-form";
import { writeErrorState } from "~/components/resource-form";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { type CollectionInput, getCollection, updateCollection } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "Edit · Collections · Knowledge · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw new ApiError(404, "missing collection id");
  const collection = await getCollection(id);
  return { collection };
}

export default function CollectionEdit() {
  const { collection } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const detailPath = `/knowledge/collections/${encodeURIComponent(collection.id)}`;

  async function onSubmit(body: CollectionInput) {
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);
    try {
      await updateCollection(collection.id, collection.version, body);
      navigate(detailPath);
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
    { label: collection.name, to: detailPath },
    { label: "edit" },
  ];

  return (
    <ResourcePanel crumbs={crumbs}>
      <CollectionForm
        mode="edit"
        initial={{
          name: collection.name,
          description: collection.description,
          domain: collection.domain,
        }}
        onSubmit={onSubmit}
        submitting={submitting}
        fieldErrors={fieldErrors}
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
