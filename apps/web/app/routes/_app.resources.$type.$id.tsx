import {
  type ClientLoaderFunctionArgs,
  Link,
  type MetaFunction,
  useLoaderData,
  useParams,
  useRouteError,
} from "@remix-run/react";
import { DetailView } from "~/components/detail-view";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError, getRecord, listResourceTypes } from "~/lib/api";
import { deriveFields, detailFields, parseSchema } from "~/lib/schema";

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
  return { type, record, fields, schemaError };
}

export default function ResourceDetail() {
  const { type, record, fields, schemaError } = useLoaderData<typeof clientLoader>();

  const crumbs = [
    { label: "resources", to: "/resources" },
    { label: type, to: `/resources/${encodeURIComponent(type)}` },
    { label: record.id },
  ];
  const command = `tulipfarm resources ${type} show ${record.id}`;

  return (
    <ResourcePanel crumbs={crumbs} command={command}>
      <div>
        <Button asChild variant="outline" size="sm">
          <Link to={`/resources/${encodeURIComponent(type)}/${encodeURIComponent(record.id)}/edit`}>
            Edit
          </Link>
        </Button>
      </div>
      {schemaError ? (
        <p className="text-destructive">error: schema parse failed — {schemaError}</p>
      ) : (
        <DetailView fields={fields} record={record} />
      )}
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const params = useParams();
  const command = `tulipfarm resources ${params.type ?? ""} show ${params.id ?? ""}`;
  if (error instanceof ApiError && error.status === 404) {
    return <NotFoundState section="resources" command={command} />;
  }
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="resources" command={command} status={status} message={message} />;
}
