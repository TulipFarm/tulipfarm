import { RotateCw } from "lucide-react";
import { useId } from "react";
import {
  ACTIVITY_RANGES,
  ACTIVITY_SOURCES,
  type ActivityRange,
  type ActivitySource,
  PAGE_SIZES,
  type PageSize,
  RANGE_LABELS,
  SOURCE_LABELS,
} from "~/lib/activity-feed";
import { cn } from "~/lib/utils";
import { Checkbox } from "../ui/checkbox";
import { Select } from "../ui/select";

/** Off, then intervals long enough that a reader can finish a row before it moves. */
export const REFRESH_SECONDS = [0, 15, 30, 60] as const;

export type RefreshSeconds = (typeof REFRESH_SECONDS)[number];

export function asRefreshSeconds(value: string | number | null | undefined): RefreshSeconds {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return REFRESH_SECONDS.includes(parsed as RefreshSeconds) ? (parsed as RefreshSeconds) : 0;
}

export type ActivityFilterState = {
  source: ActivitySource;
  range: ActivityRange;
  problemsOnly: boolean;
  pageSize: PageSize;
  refreshSeconds: RefreshSeconds;
};

const CONTROL = "h-11 w-auto rounded-md border border-input bg-background px-2 text-sm sm:h-9";

/** The control is a component, so the association has to be spelled out rather than nested. */
function Labelled({
  label,
  trailing = false,
  children,
}: {
  label: string;
  /** Puts the label after the control, where a checkbox expects to find it. */
  trailing?: boolean;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  const text = (
    <label htmlFor={id} className={cn("whitespace-nowrap", trailing && "cursor-pointer")}>
      {label}
    </label>
  );
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      {trailing ? null : text}
      {children(id)}
      {trailing ? text : null}
    </div>
  );
}

export function ActivityFilters({
  state,
  canReadRuns,
  filtered,
  onChange,
  onReset,
}: {
  state: ActivityFilterState;
  /** False hides the Runs chip: the session has no authority to read that feed. */
  canReadRuns: boolean;
  /** Whether anything differs from the default view, so Reset has something to undo. */
  filtered: boolean;
  onChange: (patch: Partial<ActivityFilterState>) => void;
  onReset: () => void;
}) {
  const sources = ACTIVITY_SOURCES.filter((source) => canReadRuns || source !== "run");

  return (
    <div className="flex flex-col gap-4">
      {/*
        Exactly one source is active at a time, so these are radios and not toggles. `aria-pressed`
        announced ten independent switches with no cue that choosing one released the last, and a
        native radio group also brings arrow-key movement and a roving tab stop for free.
      */}
      <fieldset className="-mx-1 flex flex-wrap gap-1.5 px-1">
        <legend className="sr-only">Filter by what happened</legend>
        {sources.map((source) => {
          const active = source === state.source;
          return (
            <label
              key={source}
              className={cn(
                "flex h-11 cursor-pointer items-center rounded-md border px-3 text-sm transition-colors sm:h-9",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                active
                  ? "border-primary/40 bg-primary/10 font-medium text-foreground"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground active:bg-accent"
              )}
            >
              <input
                type="radio"
                name="activity-source"
                value={source}
                checked={active}
                onChange={() => onChange({ source })}
                className="sr-only"
              />
              {SOURCE_LABELS[source]}
            </label>
          );
        })}
      </fieldset>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Labelled label="Time range">
          {(id) => (
            <Select
              id={id}
              className={CONTROL}
              value={state.range}
              onChange={(event) => onChange({ range: event.currentTarget.value as ActivityRange })}
            >
              {ACTIVITY_RANGES.map((range) => (
                <option key={range} value={range}>
                  {RANGE_LABELS[range]}
                </option>
              ))}
            </Select>
          )}
        </Labelled>

        <Labelled label="Auto refresh">
          {(id) => (
            <Select
              id={id}
              className={CONTROL}
              value={String(state.refreshSeconds)}
              onChange={(event) =>
                onChange({ refreshSeconds: asRefreshSeconds(event.currentTarget.value) })
              }
            >
              {REFRESH_SECONDS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds === 0 ? "Off" : `Every ${seconds}s`}
                </option>
              ))}
            </Select>
          )}
        </Labelled>

        <Labelled label="Per page">
          {(id) => (
            <Select
              id={id}
              className={CONTROL}
              value={String(state.pageSize)}
              onChange={(event) =>
                onChange({ pageSize: Number(event.currentTarget.value) as PageSize })
              }
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </Select>
          )}
        </Labelled>

        <Labelled label="Problems only" trailing>
          {(id) => (
            <Checkbox
              id={id}
              className="size-5 cursor-pointer sm:size-4"
              checked={state.problemsOnly}
              onChange={(event) => onChange({ problemsOnly: event.currentTarget.checked })}
            />
          )}
        </Labelled>

        {filtered ? (
          <button
            type="button"
            onClick={onReset}
            className="ml-auto flex h-11 cursor-pointer items-center gap-1.5 text-sm text-primary underline-offset-4 transition-colors hover:underline active:text-primary/70 sm:h-9"
          >
            <RotateCw className="size-3.5" aria-hidden />
            Reset filters
          </button>
        ) : null}
      </div>
    </div>
  );
}
