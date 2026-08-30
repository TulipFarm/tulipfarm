import {
  type ClientLoaderFunctionArgs,
  Link,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { type FormEvent, useState } from "react";
import { PageShell } from "~/components/page-shell";
import { ErrorState, NotFoundState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError, listResourceTypes, updateResourceType } from "~/lib/api";

export const meta: MetaFunction = () => [{ title: "Edit type · Resources · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const type = params.type;
  if (!type) throw new ApiError(404, "missing resource type");
  const types = await listResourceTypes();
  const summary = types.find((t) => t.name === type);
  if (!summary) throw new ApiError(404, `resource type not found: ${type}`);
  return { type, schema: summary.schema };
}

export default function ResourceTypeEdit() {
  const { type, schema } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [value, setValue] = useState(schema);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listPath = `/resources/${encodeURIComponent(type)}`;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await updateResourceType(type, value);
      navigate(listPath);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to update resource type");
      setSubmitting(false);
    }
  }

  const crumbs = [
    { label: "Resources", to: "/resources" },
    { label: type, to: listPath },
    { label: "schema" },
  ];

  return (
    <PageShell crumbs={crumbs} title={`${type} schema`}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          The full JSON Schema (YAML). Editing here is lossless: relationships (x-links), id
          strategy, and other extensions are preserved. id/createdAt/updatedAt/version are managed
          by the platform.
        </p>
        {error ? <p className="text-destructive">error: {error}</p> : null}
        <textarea
          aria-label="schema"
          spellCheck={false}
          className="min-h-[24rem] w-full rounded-sm border border-border bg-background p-3 font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Save schema"}
          </Button>
          <Button asChild variant="outline">
            <Link to={listPath}>Cancel</Link>
          </Button>
        </div>
      </form>
    </PageShell>
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
