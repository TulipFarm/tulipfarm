import { Link } from "@remix-run/react";
import {
  AlertTriangle,
  ArrowRightLeft,
  BookOpen,
  Brain,
  Check,
  ChevronRight,
  Circle,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { useState } from "react";
import { SurfaceArtifact } from "~/components/surface-artifact";
import type { PlanStep, SourceRef, StepStatus, TimelinePart } from "~/lib/chat/types";
import { cn } from "~/lib/utils";
import { Response } from "./response";
import { ToolCallRow } from "./tool-call";
import { isHiddenToolPart } from "./tool-summary";

/** No duration: the wire carries no reasoning timing. */
function ReasoningPart({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-run-border bg-run-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-run-surface-hover hover:text-foreground focus-visible:-outline-offset-2 focus-visible:rounded-md"
      >
        <Brain aria-hidden className="size-3.5 shrink-0" />
        <span className="flex-1">{streaming === true ? "Thinking" : "Thought process"}</span>
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 transition-transform duration-150 ease-snappy",
            open && "rotate-90"
          )}
        />
      </button>
      {open ? (
        <div className="whitespace-pre-wrap border-t border-run-border px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
          {text}
        </div>
      ) : null}
    </div>
  );
}

const STEP_TONE: Record<StepStatus, string> = {
  pending: "text-run-pending",
  running: "text-run-active",
  done: "text-run-ok",
  error: "text-run-error",
};

/** The status glyph on a step rail. Shape carries the state, so colour is never the only signal. */
function StepGlyph({ status }: { status: StepStatus }) {
  const tone = STEP_TONE[status];
  if (status === "running") {
    return (
      <Loader2
        aria-hidden
        className={cn("size-3.5 motion-safe:animate-spin motion-reduce:opacity-70", tone)}
      />
    );
  }
  if (status === "done") return <Check aria-hidden className={cn("size-3.5", tone)} />;
  if (status === "error") return <AlertTriangle aria-hidden className={cn("size-3.5", tone)} />;
  return <Circle aria-hidden className={cn("size-3.5", tone)} />;
}

function PlanPart({ title, steps }: { title?: string; steps: PlanStep[] }) {
  const done = steps.filter((step) => step.status === "done").length;

  return (
    <div className="rounded-md border border-run-border bg-run-surface px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{title ?? "Plan"}</h3>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {done}/{steps.length}
        </span>
      </div>
      <ol className="mt-1.5">
        {steps.map((step, index) => (
          <li key={step.id} className="flex gap-2.5">
            <span className="flex flex-col items-center">
              <span className="flex h-6 shrink-0 items-center">
                <StepGlyph status={step.status} />
              </span>
              {index < steps.length - 1 ? (
                <span aria-hidden className="w-px flex-1 bg-run-rail" />
              ) : null}
            </span>
            <span
              className={cn(
                "text-sm leading-6",
                index < steps.length - 1 && "pb-2",
                step.status === "pending" ? "text-muted-foreground" : "text-foreground"
              )}
            >
              {step.label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A single step outside a plan. Same vocabulary as a rail row so the two read as one system. */
function TaskPart({ label, status }: { label: string; status: StepStatus }) {
  return (
    <p className="flex items-center gap-2.5 rounded-md border border-run-border bg-run-surface px-2.5 py-1.5 text-sm">
      <StepGlyph status={status} />
      <span className={cn(status === "pending" ? "text-muted-foreground" : "text-foreground")}>
        {label}
      </span>
    </p>
  );
}

/** The host a source came from, so a card can say where it is without printing a raw URL. */
function sourceHost(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  if (url.startsWith("/")) return "Knowledge";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function SourcesPart({ sources }: { sources: SourceRef[] }) {
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Sources
      </h3>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {sources.map((source, index) => {
          const label = source.title ?? source.url ?? "Source";
          const host = sourceHost(source.url);
          const internal = source.url?.startsWith("/") === true;

          const body = (
            <>
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-background/60 text-tool-tier-platform">
                {internal ? (
                  <BookOpen className="size-3.5" />
                ) : (
                  <ExternalLink className="size-3.5" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  {source.ref === undefined ? null : (
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                      [{source.ref}]
                    </span>
                  )}
                  <span className="truncate text-sm text-foreground">{label}</span>
                </span>
                {host === undefined && source.path === undefined ? null : (
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                    {source.path ?? host}
                  </span>
                )}
              </span>
            </>
          );

          const cardClass =
            "flex items-center gap-2 rounded-md border border-run-border bg-run-surface px-2 py-1.5 transition-colors";
          const key = source.id ?? source.url ?? `${source.title ?? "source"}-${index}`;

          if (source.url === undefined) {
            return (
              <li key={key} className={cn(cardClass, "opacity-70")}>
                {body}
              </li>
            );
          }

          return (
            <li key={key}>
              {internal ? (
                <Link to={source.url} className={cn(cardClass, "hover:bg-run-surface-hover")}>
                  {body}
                </Link>
              ) : (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(cardClass, "hover:bg-run-surface-hover")}
                >
                  {body}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Render one timeline part. Tool parts also host the live approval card when one is attached. */
export function MessagePartView({
  part,
  streaming,
  citations,
  onApprove,
  onSurfaceInteraction,
}: {
  part: TimelinePart;
  streaming?: boolean;
  /** The message's cited-source links, so `[n]` markers in a text part become clickable. */
  citations?: { ref: number; url: string }[];
  onApprove: (approvalId: string, decision: "approve" | "deny") => void;
  onSurfaceInteraction?: (
    handle: string,
    input: Readonly<Record<string, unknown>>
  ) => void | Promise<void>;
}) {
  switch (part.kind) {
    case "text":
      return <Response text={part.text} streaming={streaming} citations={citations} />;
    case "reasoning":
      return <ReasoningPart text={part.text} streaming={streaming} />;
    case "tool":
      // A Tool whose output already renders as something else has no row of its own; the rule lives
      // in `tool-summary.ts` so the transcript's grouping and this switch cannot drift apart.
      if (isHiddenToolPart(part)) return null;
      return <ToolCallRow part={part} streaming={streaming} onApprove={onApprove} />;
    case "plan":
      return <PlanPart title={part.title} steps={part.steps} />;
    case "task":
      return <TaskPart label={part.label} status={part.status} />;
    case "sources":
      return <SourcesPart sources={part.sources} />;
    case "agent-handoff":
      return (
        <p className="flex items-center gap-2 rounded-md border border-run-border bg-run-surface px-2.5 py-1.5 text-sm">
          <ArrowRightLeft aria-hidden className="size-3.5 shrink-0 text-run-active" />
          <span className="text-muted-foreground">
            Handed off to <span className="text-foreground">{part.to}</span>
            {part.reason ? <span> · {part.reason}</span> : null}
          </span>
        </p>
      );
    case "guardrail":
      return (
        <div className="rounded-md border border-status-warning/40 bg-status-warning/5 px-3 py-2 text-sm">
          <span className="font-mono text-xs font-medium text-status-warning">Blocked</span>{" "}
          <span className="text-foreground">{part.message ?? part.reason}</span>
        </div>
      );
    case "surface":
      return (
        <SurfaceArtifact
          artifact={part.artifact}
          artifactId={part.artifactId}
          revision={part.revision}
          actionHandles={part.actionHandles}
          resolvedView={part.resolvedView}
          onInteraction={onSurfaceInteraction}
        />
      );
    case "surface-unavailable":
      return (
        <div role="status" className="rounded-sm border border-border px-3 py-2 text-sm">
          {part.message}
        </div>
      );
  }
}
