import { AlertTriangle, ChevronRight, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { ApiError } from "~/lib/api";
import {
  formatLogTime,
  getLogs,
  LOG_LEVELS,
  LOG_SERVICES,
  type LogEvent,
  type LogEventLevel,
  type LogService,
} from "~/lib/logs";
import { cn } from "~/lib/utils";

const PAGE_SIZE = 50;

type Filters = { level?: LogEventLevel; service?: LogService; q: string };

export function LogsPanel({
  initial,
}: {
  initial: { items: LogEvent[]; nextCursor: string | null };
}) {
  const [items, setItems] = useState<LogEvent[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [filters, setFilters] = useState<Filters>({ q: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Generation guard: a slower earlier query must not overwrite the filter the user just picked.
  const req = useRef(0);

  async function load(next: Filters, append = false): Promise<void> {
    const id = ++req.current;
    setLoading(true);
    setError(null);
    try {
      const page = await getLogs({
        level: next.level,
        service: next.service,
        q: next.q.trim() || undefined,
        limit: PAGE_SIZE,
        cursor: append ? (cursor ?? undefined) : undefined,
      });
      if (id !== req.current) return;
      setItems((prev) => (append ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      if (id !== req.current) return;
      setError(e instanceof ApiError ? e.message : "Could not load logs.");
    } finally {
      if (id === req.current) setLoading(false);
    }
  }

  function apply(patch: Partial<Filters>): void {
    const next = { ...filters, ...patch };
    setFilters(next);
    void load(next);
  }

  return (
    <Panel
      title="Error logs"
      description="Errors and fatals across the API, worker, and integration worker."
      actions={
        <button
          type="button"
          onClick={() => void load(filters)}
          disabled={loading}
          aria-label="Refresh logs"
          className="inline-flex size-8 cursor-pointer items-center justify-center rounded-sm border border-border text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw
            className={cn(
              "size-3.5",
              loading && "motion-safe:animate-spin motion-reduce:opacity-70"
            )}
          />
        </button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <FilterGroup
          label="Level"
          options={LOG_LEVELS}
          value={filters.level}
          onChange={(level) => apply({ level: level as LogEventLevel | undefined })}
        />
        <FilterGroup
          label="Service"
          options={LOG_SERVICES}
          value={filters.service}
          onChange={(service) => apply({ service: service as LogService | undefined })}
        />
        <input
          type="search"
          value={filters.q}
          onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply({ q: filters.q });
          }}
          onBlur={() => apply({ q: filters.q })}
          placeholder="Search messages…"
          aria-label="Search log messages"
          className="min-w-0 flex-1 rounded-sm border border-border bg-background px-2.5 py-1 text-sm text-foreground placeholder:text-muted-foreground sm:max-w-56"
        />
      </div>

      {error ? (
        <p className="mt-4 rounded-sm bg-run-error/10 px-3 py-2 text-run-error text-sm">{error}</p>
      ) : null}

      {items.length === 0 && !error ? (
        <div className="mt-4">
          <PanelEmpty>
            {filters.level || filters.service || filters.q.trim()
              ? "No logs match these filters."
              : "No errors recorded. Nothing has failed in the retention window."}
          </PanelEmpty>
        </div>
      ) : (
        <ul className="mt-4 space-y-px">
          {items.map((log) => (
            <LogRow key={log.id} log={log} />
          ))}
        </ul>
      )}

      {cursor ? (
        <button
          type="button"
          onClick={() => void load(filters, true)}
          disabled={loading}
          className="mt-3 w-full cursor-pointer rounded-sm border border-border py-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load older"}
        </button>
      ) : null}
    </Panel>
  );
}

function FilterGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="sr-only">{label}</span>
      {["All", ...options].map((option) => {
        const key = option === "All" ? undefined : option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={value === key}
            onClick={() => onChange(key)}
            className={cn(
              "cursor-pointer rounded-sm border px-2 py-1 text-xs transition-colors",
              value === key
                ? "border-primary text-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

function LogRow({ log }: { log: LogEvent }) {
  const [open, setOpen] = useState(false);
  const attributes = Object.entries(log.attributes);
  const correlations = [
    ["request", log.requestId],
    ["run", log.runId],
    ["chat", log.conversationId],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  const expandable = Boolean(log.stack) || attributes.length > 0 || correlations.length > 0;

  return (
    <li className={cn("rounded-sm", log.level === "fatal" && "bg-run-error/5")}>
      <button
        type="button"
        onClick={() => expandable && setOpen(!open)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        className={cn(
          "flex w-full items-start gap-2 px-2 py-1.5 text-left transition-colors",
          expandable ? "cursor-pointer hover:bg-run-surface-hover" : "cursor-default"
        )}
      >
        {expandable ? (
          <ChevronRight
            aria-hidden
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90"
            )}
          />
        ) : (
          <span aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        )}
        <time
          dateTime={log.ts}
          className="mt-px shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums"
        >
          {formatLogTime(log.ts)}
        </time>
        <span className="mt-px shrink-0 font-mono text-[11px] text-muted-foreground">
          {log.service}
        </span>
        {log.level === "fatal" ? (
          <span className="mt-px inline-flex shrink-0 items-center gap-1 rounded-sm bg-run-error/10 px-1 font-medium text-[11px] text-run-error">
            <AlertTriangle aria-hidden className="size-3" />
            fatal
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 flex-1 break-words font-mono text-xs",
            log.level === "fatal" ? "text-run-error" : "text-foreground"
          )}
        >
          {log.message}
        </span>
      </button>

      {open ? (
        <div className="space-y-2 border-code-border border-t bg-code-surface px-3 py-2">
          {correlations.length > 0 ? (
            <dl className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
              {correlations.map(([label, value]) => (
                <div key={label} className="flex gap-1">
                  <dt className="text-code-key">{label}</dt>
                  <dd className="text-code-string">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {attributes.length > 0 ? (
            <dl className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
              {attributes.map(([key, value]) => (
                <div key={key} className="flex gap-1">
                  <dt className="text-code-key">{key}</dt>
                  <dd className="text-code-string">{String(value)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {log.stack ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
              {log.stack}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
