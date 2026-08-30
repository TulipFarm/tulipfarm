import { useId, useMemo, useState } from "react";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import type { RoutineSummary, RunStatus } from "~/lib/routines";
import {
  GROUP_LABEL,
  groupByTriggerKind,
  matchesRoutineQuery,
  type RunHealth,
  routineTriggerKinds,
  runHealth,
  TRIGGER_KIND_LABEL,
  type TriggerKind,
} from "~/lib/routines/facts";
import { RoutineRow } from "./routine-row";

const KIND_OPTIONS: readonly TriggerKind[] = ["schedule", "event", "request", "human"];
const HEALTH_OPTIONS: readonly RunHealth[] = ["healthy", "attention", "failing", "never-run"];
const HEALTH_LABEL: Record<RunHealth, string> = {
  healthy: "Last run fine",
  attention: "Needs attention",
  failing: "Last run failed",
  "never-run": "Never run",
};

/** The newest Run of each Routine, keyed by routine id. */
export type LatestRuns = Record<string, { id: string; status: RunStatus; createdAt: string }>;

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <p className="font-mono text-lg tabular-nums text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function RoutineList({
  routines,
  latest,
  headingLevel,
}: {
  routines: readonly RoutineSummary[];
  latest: LatestRuns;
  headingLevel?: 2 | 3;
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
      {routines.map((routine) => {
        const run = latest[routine.id];
        return (
          <li key={routine.slug} className="min-w-0">
            <RoutineRow
              routine={routine}
              latest={run}
              health={runHealth(run)}
              headingLevel={headingLevel}
            />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The Routine catalog: everything this instance automates, grouped by how it starts.
 *
 * Grouped by Trigger kind rather than by name, because the question a person brings to this page
 * is almost never "where is the one called X" — it is "what runs on its own", "what is waiting on
 * a person", and "what is currently broken". Name lookup is what the search box is for.
 *
 * Filtering is client-side and deliberately so: the whole catalog arrives in one response, so a
 * round trip per keystroke would buy nothing.
 */
export function RoutineCatalog({
  routines,
  latest,
}: {
  routines: readonly RoutineSummary[];
  latest: LatestRuns;
}) {
  const searchId = useId();
  const kindId = useId();
  const healthId = useId();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<TriggerKind | "">("");
  const [health, setHealth] = useState<RunHealth | "">("");

  const visible = useMemo(
    () =>
      routines.filter(
        (routine) =>
          matchesRoutineQuery(routine, query) &&
          (kind === "" || routineTriggerKinds(routine).includes(kind)) &&
          (health === "" || runHealth(latest[routine.id]) === health)
      ),
    [routines, query, kind, health, latest]
  );

  const groups = useMemo(() => groupByTriggerKind(visible), [visible]);
  const automatic = useMemo(
    () => routines.filter((routine) => routine.triggers.length > 0).length,
    [routines]
  );
  const unhealthy = useMemo(
    () =>
      routines.filter((routine) => ["failing", "attention"].includes(runHealth(latest[routine.id])))
        .length,
    [routines, latest]
  );
  const filtered = visible.length !== routines.length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-4 border-b border-border pb-5">
        <Stat value={routines.length} label={routines.length === 1 ? "routine" : "routines"} />
        <Stat value={automatic} label="run on their own" />
        <Stat value={unhealthy} label="need a look" />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor={searchId} className="mb-1 block text-xs text-muted-foreground">
            Search routines
          </label>
          <Input
            id={searchId}
            type="search"
            value={query}
            placeholder="Name, owner, schedule, or a step type"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="sm:w-48">
          <label htmlFor={kindId} className="mb-1 block text-xs text-muted-foreground">
            Starts
          </label>
          <Select
            id={kindId}
            value={kind}
            onChange={(event) => setKind(event.target.value as TriggerKind | "")}
          >
            <option value="">Any way</option>
            {KIND_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {TRIGGER_KIND_LABEL[value]}
              </option>
            ))}
          </Select>
        </div>
        <div className="sm:w-44">
          <label htmlFor={healthId} className="mb-1 block text-xs text-muted-foreground">
            Health
          </label>
          <Select
            id={healthId}
            value={health}
            onChange={(event) => setHealth(event.target.value as RunHealth | "")}
          >
            <option value="">Any health</option>
            {HEALTH_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {HEALTH_LABEL[value]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <p role="status" className="text-xs text-muted-foreground">
        {filtered ? `${visible.length} of ${routines.length} routines match` : ""}
      </p>

      {visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No routine matches those filters. Clear the search or widen how it starts and its health.
        </p>
      ) : groups.length > 1 ? (
        groups.map(([key, members], index) => (
          <section
            key={key}
            aria-labelledby={`${searchId}-group-${index}`}
            className="flex flex-col gap-3"
          >
            <div className="flex items-baseline gap-2">
              <h2
                id={`${searchId}-group-${index}`}
                className="text-[0.625rem] font-medium uppercase tracking-[0.2em] text-muted-foreground"
              >
                {GROUP_LABEL[key]}
              </h2>
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
                {members.length}
              </span>
              <span aria-hidden className="h-px flex-1 bg-border" />
            </div>
            <RoutineList routines={members} latest={latest} />
          </section>
        ))
      ) : (
        <RoutineList routines={visible} latest={latest} headingLevel={2} />
      )}
    </div>
  );
}
