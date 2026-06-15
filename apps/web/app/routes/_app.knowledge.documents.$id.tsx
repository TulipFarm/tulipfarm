import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { DocDetail } from "~/components/knowledge/doc-detail";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { deleteDocument, getDocument } from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "Document · Knowledge · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw new ApiError(404, "missing document id");
  const doc = await getDocument(id);
  return { doc };
}

export default function DocumentDetail() {
  const { doc } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    setDeleting(true);
    setError(null);
    try {
      await deleteDocument(doc.id);
      navigate("/knowledge/documents");
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
      setDeleting(false);
    }
  }

  const crumbs = [
    { label: "knowledge", to: "/knowledge" },
    { label: "documents", to: "/knowledge/documents" },
    { label: doc.title },
  ];

  return (
    <ResourcePanel crumbs={crumbs}>
      {error ? <p className="text-destructive">error: {error}</p> : null}
      <DocDetail
        doc={doc}
        editTo={`/knowledge/documents/${encodeURIComponent(doc.id)}/edit`}
        onDelete={onDelete}
        deleting={deleting}
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
