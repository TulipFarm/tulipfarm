import { AlertTriangle, Check, ChevronDown, Circle, Loader2, Search, Sparkles } from "lucide-react";
import {
  type ComponentType,
  type ElementType,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import { cn } from "~/lib/utils";
import { DiffCount, ToolChip } from "./tool-chip";

/**
 * A Trace is the disclosure of interior work — the steps, the reasoning, the lookups a Turn did on
 * its way to an answer. It follows the work live and then gets out of the way:
 *
 *   working   the trace is open, and the step in flight shows its detail
 *   settled   every step collapses to one line and the trace folds to its header
 *
 * The reader's own toggle overrides that policy for good, because a panel that keeps reopening
 * itself under someone who closed it is worse than one that never opened.
 *
 * The Trace is the only presentation a run of interior work gets — live, settled or failed. There
 * is no second, bordered record beside it: the box costs a border, a radius and a slab of chrome
 * above the answer the reader actually asked for, and buys nothing the rail does not carry.
 */

/** The four states a step can be in. Deliberately local, so a primitive never depends on Chat. */
export const TRACE_STATUSES = ["pending", "running", "done", "error"] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

/** Shape carries the state; the tone only reinforces it. */
export function TraceStatusGlyph({
  status,
  className,
}: {
  status: TraceStatus;
  className?: string;
}) {
  const shared = cn("size-3.5 shrink-0", className);
  if (status === "running") {
    return (
      <Loader2
        aria-hidden
        className={cn(shared, "text-run-active motion-safe:animate-spin motion-reduce:opacity-70")}
      />
    );
  }
  if (status === "done") {
    return <Check aria-hidden className={cn(shared, "text-run-ok")} strokeWidth={2.75} />;
  }
  if (status === "error") {
    return <AlertTriangle aria-hidden className={cn(shared, "text-run-error")} />;
  }
  return <Circle aria-hidden className={cn(shared, "text-run-pending")} />;
}

function formatElapsed(tenths: number) {
  const seconds = tenths / 10;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}

/**
 * Reports how long the trace has been working. An authoritative `durationMs` from the wire always
 * wins; otherwise the trace times itself and stays silent until it has actually measured
 * something, so a restored conversation never claims a confident `0.0s`.
 */
function useWorkedFor(working: boolean, durationMs: number | undefined) {
  const [tenths, setTenths] = useState(0);

  useEffect(() => {
    if (!working || durationMs !== undefined) return;
    const timer = setInterval(() => setTenths((value) => value + 1), 100);
    return () => clearInterval(timer);
  }, [working, durationMs]);

  if (durationMs !== undefined) return formatElapsed(Math.round(durationMs / 100));
  return tenths === 0 ? undefined : formatElapsed(tenths);
}

export type TraceProps = {
  /** Present tense, shimmering while the work is in flight: `Thinking`, `Searching the web`. */
  activeLabel: string;
  /** Past tense, once it is over: `Thought`, `Searched the web`, `Ran 3 tools · 1 failed`. */
  settledLabel: string;
  /**
   * `error` marks the whole trace as having failed somewhere inside it. It swaps the header glyph
   * rather than tinting the label, so the failure is scannable without the summary shouting — and
   * so the accessible name stays one clean sentence instead of a concatenation.
   */
  tone?: "default" | "error";
  working: boolean;
  /** Authoritative duration from the wire. Omit to let the trace time its own working period. */
  durationMs?: number;
  showElapsed?: boolean;
  /** Stay open after settling — set it when the trace still holds something to act on. */
  keepOpen?: boolean;
  icon?: ComponentType<{ className?: string }>;
  children: ReactNode;
  className?: string;
};

export function Trace({
  activeLabel,
  settledLabel,
  tone,
  working,
  durationMs,
  showElapsed = true,
  keepOpen,
  icon: Icon = Sparkles,
  children,
  className,
}: TraceProps) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const bodyId = useId();
  const elapsed = useWorkedFor(working, durationMs);
  const open = choice ?? (working || keepOpen === true);
  const label = working ? activeLabel : settledLabel;
  const failed = tone === "error";
  const HeaderIcon = failed ? AlertTriangle : Icon;

  return (
    <div className={cn("flex w-full flex-col", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setChoice(!open)}
        className="-mx-1.5 flex w-fit max-w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-run-surface-hover focus-visible:-outline-offset-2"
      >
        <HeaderIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            failed ? "text-run-error" : working ? "text-foreground" : "text-muted-foreground"
          )}
        />
        {/* The word shimmers only while work is genuinely in flight; the settled label is still. */}
        <span
          className={cn(
            "truncate text-sm font-medium",
            working ? "tf-loader-label" : "text-muted-foreground"
          )}
        >
          {label}
        </span>
        {showElapsed && elapsed !== undefined ? (
          // Ticking, so it is kept out of the announced name and out of the live region below.
          <span
            aria-hidden
            className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
          >
            {elapsed}
          </span>
        ) : null}
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-150 ease-snappy",
            open && "rotate-180"
          )}
        />
      </button>

      {/* One stable sentence per phase. The elapsed value is deliberately not in here. */}
      <span role="status" className="sr-only">
        {label}
      </span>

      <div
        id={bodyId}
        // `inert` rather than `aria-hidden`: a collapsed trace must leave the tab order too.
        inert={open ? undefined : true}
        className="grid transition-[grid-template-rows] duration-300 ease-snappy"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="ml-[6px] flex flex-col gap-0.5 border-l border-run-border py-1 pl-3.5">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export type TraceStepProps = {
  status: TraceStatus;
  /** Past tense once it has run, naming the object: `Read the overdue invoices`. */
  label: string;
  /**
   * Present participle for the moment it is in flight: `Reading the overdue invoices`. A live step
   * described in the past tense claims to be finished; without this the label is used for both.
   */
  activeLabel?: string;
  /** The object it acted on — a path, a command, a count. Rendered as a chip. */
  value?: ReactNode;
  mono?: boolean;
  /** A standing property of the step rather than its outcome — that it can write, say. */
  marker?: ReactNode;
  diff?: { added: number; removed: number };
  /** What the step actually did. Shown while it is the live step, on demand once it settles. */
  detail?: ReactNode;
  className?: string;
};

/**
 * One step in a trace. Status leads the row, as it does on a Tool row, so a reader scans a column
 * of outcomes rather than hunting a trailing glyph at a ragged x-position.
 *
 * The row follows the same policy as the trace around it: the step in flight is expanded, settled
 * steps collapse to their one line, and a failure holds itself open because the error is the
 * evidence. A reader's own toggle wins after that.
 */
export function TraceStep({
  status,
  label,
  activeLabel,
  value,
  mono,
  marker,
  diff,
  detail,
  className,
}: TraceStepProps) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const bodyId = useId();
  const open = choice ?? (status === "running" || status === "error");
  const expandable = detail !== undefined;
  const shown = status === "running" ? (activeLabel ?? label) : label;

  const face = (
    <>
      <TraceStatusGlyph status={status} />
      <span
        className={cn(
          "shrink-0 truncate text-sm",
          status === "pending" ? "text-muted-foreground" : "text-foreground"
        )}
      >
        {shown}
      </span>
      {value === undefined ? null : <ToolChip mono={mono}>{value}</ToolChip>}
      {marker}
      {diff === undefined ? null : <DiffCount {...diff} />}
      {expandable ? (
        <ChevronDown
          aria-hidden
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground/0 transition-[transform,color] duration-150 ease-snappy group-hover/step:text-muted-foreground",
            open && "rotate-180 text-muted-foreground/60"
          )}
        />
      ) : null}
    </>
  );

  const rowClass = cn(
    "tf-trace-row group/step -mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-left",
    className
  );

  return (
    <div>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setChoice(!open)}
          className={cn(
            rowClass,
            "transition-colors hover:bg-run-surface-hover focus-visible:-outline-offset-2"
          )}
        >
          {face}
        </button>
      ) : (
        <div className={rowClass}>{face}</div>
      )}

      {expandable ? (
        <div
          id={bodyId}
          inert={open ? undefined : true}
          className="grid transition-[grid-template-rows] duration-300 ease-snappy"
          style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        >
          <div className="overflow-hidden">
            <div className="mb-1 ml-[6px] flex flex-col gap-0.5 border-l border-run-border py-0.5 pl-3.5 text-xs leading-relaxed text-muted-foreground">
              {detail}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The query a search trace ran, sitting above the sources it came back with. */
export function TraceQuery({ children }: { children: ReactNode }) {
  return (
    <p className="tf-trace-row -mx-1.5 flex items-center gap-2 px-1.5 py-1 text-sm text-muted-foreground">
      <Search aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
    </p>
  );
}

/** A line of reasoning. Prose, so it wraps and keeps its measure rather than truncating. */ export function TraceNote({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn("tf-trace-row py-0.5 text-sm leading-relaxed text-muted-foreground", className)}
    >
      {children}
    </p>
  );
}

/**
 * A source a trace read. It borrows the citation vocabulary the transcript already uses — a mono
 * `[n]` and the host — rather than the per-site color dots of the reference, which would spend the
 * categorical data palette on decoration.
 */
export function TraceSource({
  title,
  href,
  host,
  ref: reference,
  icon: Icon,
  className,
  as: LinkAs,
}: {
  title: string;
  href?: string;
  host?: string;
  ref?: number;
  icon?: ComponentType<{ className?: string }>;
  className?: string;
  /**
   * The element that renders `href`. Defaults to `<a>`; pass the router's link component for an
   * in-app destination. It is a prop so this layer stays free of any routing dependency.
   */
  as?: ElementType;
}) {
  const face = (
    <>
      {Icon === undefined ? null : (
        <Icon aria-hidden className="size-3.5 shrink-0 text-tool-tier-platform" />
      )}
      {reference === undefined ? null : (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          [{reference}]
        </span>
      )}
      <span className="min-w-0 truncate text-sm text-foreground">{title}</span>
      {host === undefined ? null : (
        <span className="shrink-0 truncate text-xs text-muted-foreground">{host}</span>
      )}
    </>
  );

  const rowClass = cn(
    "tf-trace-row -mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1",
    className
  );

  if (href === undefined) return <div className={rowClass}>{face}</div>;

  const linkClass = cn(
    rowClass,
    "transition-colors hover:bg-run-surface-hover focus-visible:-outline-offset-2"
  );

  if (LinkAs !== undefined) {
    return (
      <LinkAs to={href} className={linkClass}>
        {face}
      </LinkAs>
    );
  }

  return (
    <a href={href} target="_blank" rel="noreferrer" className={linkClass}>
      {face}
    </a>
  );
}
