import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useParams,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { DocForm } from "~/components/knowledge/doc-form";
import { writeErrorState } from "~/components/resource-form";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { type DocumentInput, getDocument, updateDocument } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "Edit · Documents · Knowledge · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw new ApiError(404, "missing document id");
  const doc = await getDocument(id);
  return { doc };
}

export default function DocumentEdit() {
  const { doc } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const detailPath = `/knowledge/documents/${encodeURIComponent(doc.id)}`;

  async function onSubmit(body: DocumentInput) {
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);
    try {
      await updateDocument(doc.id, doc.version, body);
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
    { label: "documents", to: "/knowledge/documents" },
    { label: doc.title, to: detailPath },
    { label: "edit" },
  ];

  return (
    <ResourcePanel crumbs={crumbs} command={`tulipfarm knowledge documents edit ${doc.id}`}>
      <DocForm
        mode="edit"
        initial={{
          title: doc.title,
          content: doc.content,
          tags: doc.tags,
          domain: doc.domain,
          alwaysLoadForAgents: doc.alwaysLoadForAgents,
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
  const params = useParams();
  const command = `tulipfarm knowledge documents edit ${params.id ?? ""}`;
  if (error instanceof ApiError && error.status === 404) {
    return <NotFoundState section="knowledge" command={command} />;
  }
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="knowledge" command={command} status={status} message={message} />;
}
