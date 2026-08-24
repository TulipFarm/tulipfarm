import { Link, useLoaderData, useNavigate, useRevalidator, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { ResourcePanel } from "~/components/resource-panel";
import { RoutineCanvas } from "~/components/routines/routine-canvas";
import { RunStatusBadge } from "~/components/routines/run-status-badge";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import { getRoutine, listRuns, type RoutineInputsSchema, triggerRun } from "~/lib/routines";
import { projectRoutineGraph } from "~/lib/routines/graph";

export async function clientLoader({ params }: { params: { slug: string } }) {
  const slug = params.slug;
  const [routine, runs] = await Promise.all([getRoutine(slug), listRuns(slug)]);
  return { routine, runs };
}

/** Validation remains server-authoritative; the API 400 message renders below. */
function TriggerForm({
  routine,
  onTriggered,
}: {
  routine: { slug: string; inputs?: RoutineInputsSchema | null };
  onTriggered: (runId: string) => void;
}) {
  const schema: RoutineInputsSchema = routine.inputs ?? {};
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { runId } = await triggerRun(routine.slug, values);
      onTriggered(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const setValue = (key: string, value: unknown) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-sm border border-border p-3">
      <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">manual trigger</p>
      {Object.entries(properties).map(([key, prop]) => {
        const label = (
          <span className="text-xs text-muted-foreground">
            {key}
            {required.has(key) ? <span className="text-primary"> *</span> : null}
          </span>
        );
        if (prop.enum) {
          return (
            <label key={key} className="flex flex-col gap-1">
              {label}
              <select
                className="rounded-sm border border-border bg-background px-2 py-1.5 text-sm"
                value={String(values[key] ?? "")}
                onChange={(e) => setValue(key, e.target.value)}
              >
                <option value="">—</option>
                {prop.enum.map((opt) => (
                  <option key={String(opt)} value={String(opt)}>
                    {String(opt)}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        if (prop.type === "boolean") {
          return (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(values[key])}
                onChange={(e) => setValue(key, e.target.checked)}
              />
              {label}
            </label>
          );
        }
        const isNumber = prop.type === "number" || prop.type === "integer";
        return (
          <label key={key} className="flex flex-col gap-1">
            {label}
            <input
              type={isNumber ? "number" : "text"}
              className="rounded-sm border border-border bg-background px-2 py-1.5 text-sm"
              placeholder={prop.description}
              value={String(values[key] ?? "")}
              onChange={(e) => setValue(key, isNumber ? Number(e.target.value) : e.target.value)}
            />
          </label>
        );
      })}
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
      <Button type="submit" size="sm" disabled={submitting} className="self-start">
        {submitting ? "starting…" : "run now"}
      </Button>
    </form>
  );
}

export default function RoutineDetailRoute() {
  const { routine, runs } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const definition = routine.definition;
  const triggers = routine.triggers;
  const inputs = (definition.spec.input ?? null) as RoutineInputsSchema | null;
  // A Routine with no Trigger at all is still startable by hand: this button is the manual door,
  // and a manual Trigger definition is one more way in, not a precondition for this one.
  const triggerSummary = triggers.map((trigger) => trigger.type).join(", ") || "none";

  return (
    <ResourcePanel crumbs={[{ label: "routines", to: "/routines" }, { label: routine.slug }]}>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h1 className="font-medium text-foreground">{routine.displayName ?? routine.slug}</h1>
          <Button asChild size="sm" variant="outline">
            <Link to={`/routines/${encodeURIComponent(routine.slug)}/edit`}>author</Link>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          v{routine.authoredVersion} · triggers: {triggerSummary}
        </p>
      </div>

      <RoutineCanvas graph={projectRoutineGraph(definition, triggers)} mode="read" />

      <TriggerForm
        routine={{ slug: routine.slug, inputs }}
        onTriggered={(runId) => navigate(`/runs/${runId}`)}
      />

      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">run history</p>
        <Button size="sm" variant="ghost" onClick={() => revalidator.revalidate()}>
          refresh
        </Button>
      </div>
      {runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No runs yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
          {runs.map((run) => (
            <li key={run.id}>
              <Link
                to={`/runs/${run.id}`}
                className="flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-accent"
              >
                <RunStatusBadge status={run.status} />
                <span className="font-mono text-xs text-muted-foreground">
                  {run.id.slice(0, 8)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(run.createdAt).toLocaleString()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="routines" status={status} message={message} />;
}
