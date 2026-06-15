import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { CollectionDetail } from "~/components/knowledge/collection-detail";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { ApiError } from "~/lib/api";
import {
  addDocToCollection,
  getCollection,
  getCollectionDocumentIds,
  getDocument,
  type KnowledgeDocument,
  removeDocFromCollection,
} from "~/lib/knowledge-api";

export const meta: MetaFunction = () => [{ title: "Collection · Knowledge · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw new ApiError(404, "missing collection id");
  const collection = await getCollection(id);
  const { documentIds } = await getCollectionDocumentIds(id);
  // Resolve member ids to documents for a title+link list; skip any that 404 (soft-deleted).
  const resolved = await Promise.all(
    documentIds.map(async (did) => {
      try {
        return await getDocument(did);
      } catch {
        return null;
      }
    })
  );
  const documents = resolved.filter((d): d is KnowledgeDocument => d !== null);
  return { collection, documents };
}

export default function CollectionDetailRoute() {
  const { collection, documents } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAdd(documentId: string) {
    setBusy(true);
    setError(null);
    try {
      await addDocToCollection(collection.id, documentId);
      revalidator.revalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "add failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(documentId: string) {
    setBusy(true);
    setError(null);
    try {
      await removeDocFromCollection(collection.id, documentId);
      revalidator.revalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "remove failed");
    } finally {
      setBusy(false);
    }
  }

  const crumbs = [
    { label: "knowledge", to: "/knowledge" },
    { label: "collections", to: "/knowledge/collections" },
    { label: collection.name },
  ];

  return (
    <ResourcePanel crumbs={crumbs}>
      {error ? <p className="text-destructive">error: {error}</p> : null}
      <CollectionDetail
        collection={collection}
        documents={documents}
        editTo={`/knowledge/collections/${encodeURIComponent(collection.id)}/edit`}
        onAdd={onAdd}
        onRemove={onRemove}
        busy={busy}
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
