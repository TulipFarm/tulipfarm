import {
  type ClientLoaderFunctionArgs,
  Link,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { DetailView } from "~/components/detail-view";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError, deleteRecord, getRecord, listResourceTypes } from "~/lib/api";
import { deriveFields, detailFields, parseSchema, recordLabel } from "~/lib/schema";

export const meta: MetaFunction = () => [{ title: "Resources · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const type = params.type;
  const id = params.id;
  if (!type || !id) throw new ApiError(404, "missing resource type or id");

  const types = await listResourceTypes();
  const summary = types.find((t) => t.name === type);
  if (!summary) throw new ApiError(404, `resource type not found: ${type}`);

  const parsed = parseSchema(summary.schema);
  const fields = parsed.ok ? detailFields(deriveFields(parsed.schema), parsed.schema) : [];
  const schemaError = parsed.ok ? undefined : parsed.error;

  const record = await getRecord(type, id);

  // Resolve x-links ids to the target record's display name so the detail shows "Acme Corp", not a
  // UUID. Best-effort and parallel — an unresolved link (deleted/missing target) falls back to the id.
  const linkLabels: Record<string, string> = {};
  await Promise.all(
    fields
      .filter((f) => f.kind === "link" && f.linkTarget && record[f.name])
      .map(async (f) => {
        const target = f.linkTarget;
        const linkId = String(record[f.name]);
        if (!target) return;
        try {
          linkLabels[linkId] = recordLabel(await getRecord(target, linkId));
        } catch {
          /* leave unresolved → renders the id */
        }
      })
  );

  return { type, record, fields, schemaError, linkLabels };
}

export default function ResourceDetail() {
  const { type, record, fields, schemaError, linkLabels } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const listPath = `/resources/${encodeURIComponent(type)}`;

  async function onDelete() {
    if (!window.confirm(`Delete this ${type} record? This cannot be undone from the UI.`)) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteRecord(type, record.id, record.version);
      navigate(listPath);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "delete failed");
      setDeleting(false);
    }
  }

  const crumbs = [
    { label: "resources", to: "/resources" },
    { label: type, to: listPath },
    { label: record.id },
  ];

  return (
    <ResourcePanel crumbs={crumbs}>
      <div className="flex items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to={`/resources/${encodeURIComponent(type)}/${encodeURIComponent(record.id)}/edit`}>
            Edit
          </Link>
        </Button>
        <Button variant="destructive" size="sm" onClick={onDelete} disabled={deleting}>
          {deleting ? "Deleting…" : "Delete"}
        </Button>
      </div>
      {deleteError ? <p className="text-destructive">error: {deleteError}</p> : null}
      {schemaError ? (
        <p className="text-destructive">error: schema parse failed, {schemaError}</p>
      ) : (
        <DetailView fields={fields} record={record} linkLabels={linkLabels} />
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
