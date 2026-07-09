import { Link, useLoaderData, useNavigate, useRevalidator, useRouteError } from "@remix-run/react";
import { useState } from "react";
import { ResourcePanel } from "~/components/resource-panel";
import { RunStatusBadge } from "~/components/routines/run-status-badge";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import {
  listRoutines,
  listRuns,
  type RoutineInputsSchema,
  type RoutineSummary,
  triggerRun,
} from "~/lib/routines";

export async function clientLoader({ params }: { params: { slug: string } }) {
  const slug = params.slug;
  const [routines, runs] = await Promise.all([listRoutines(), listRuns(slug)]);
  const routine = routines.find((r) => r.slug === slug);
  if (!routine) throw new ApiError(404, "routine not found");
  return { routine, runs };
}

/**
 * Manual-trigger form derived from the routine's x-inputs JSON Schema (ROUT-V1-007):
 * string → text, number/integer → number, boolean → checkbox, enum → select.
 * Validation stays server-authoritative — the API's 400 message renders below.
 */
function TriggerForm({
  routine,
  onTriggered,
}: {
  routine: RoutineSummary;
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

export default function RoutineDetail() {
  const { routine, runs } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const canTriggerManually = (routine.triggers ?? []).some((t) => t.type === "manual");

  return (
    <ResourcePanel crumbs={[{ label: "routines", to: "/routines" }, { label: routine.slug }]}>
      <div className="flex flex-col gap-1">
        <h1 className="font-medium text-foreground">{routine.name ?? routine.slug}</h1>
        {routine.description ? (
          <p className="text-muted-foreground text-sm">{routine.description}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          triggers: {(routine.triggers ?? []).map((t) => t.type).join(", ") || "none"}
          {routine.hasHooks ? " · hooks.ts" : ""}
        </p>
      </div>

      {canTriggerManually ? (
        <TriggerForm
          routine={routine}
          onTriggered={(runId) =>
            navigate(`/routines/${encodeURIComponent(routine.slug)}/runs/${runId}`)
          }
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          This routine has no manual trigger — it starts from{" "}
          {(routine.triggers ?? []).map((t) => t.type).join("/")}.
        </p>
      )}

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
                to={`/routines/${encodeURIComponent(routine.slug)}/runs/${run.id}`}
                className="flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-accent"
              >
                <RunStatusBadge status={run.status} />
                <span className="font-mono text-xs text-muted-foreground">
                  {run.id.slice(0, 8)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {run.trigger?.type ?? "?"} · {new Date(run.createdAt).toLocaleString()}
                </span>
                {run.currentState ? (
                  <span className="ml-auto text-xs text-muted-foreground">
                    at {run.currentState}
                  </span>
                ) : null}
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
