import { Link } from "@remix-run/react";
import { ArrowRightLeft, BookOpen, Brain, ExternalLink, ShieldAlert } from "lucide-react";
import { SurfaceArtifact } from "~/components/surface-artifact";
import {
  TraceStatusGlyph as StepGlyph,
  Trace,
  TraceNote,
  TraceSource,
} from "~/components/ui/trace";
import type { PlanStep, SourceRef, StepStatus, TimelinePart } from "~/lib/chat/types";
import { cn } from "~/lib/utils";
import { Response } from "./response";
import { isHiddenToolPart } from "./tool-summary";
import { ToolTrace } from "./tool-trace";

/**
 * Reasoning is interior work, so it uses the shared `Trace` disclosure: open while the model is
 * still thinking, folded to one line the moment it stops. The wire carries no reasoning timing,
 * so the trace times its own streaming window rather than claiming a duration it was not given.
 */
function ReasoningPart({ text, streaming }: { text: string; streaming?: boolean }) {
  const paragraphs = text.split(/\n{2,}/).filter((paragraph) => paragraph.trim().length > 0);

  return (
    <Trace
      icon={Brain}
      activeLabel="Thinking"
      settledLabel="Thought process"
      working={streaming === true}
    >
      {paragraphs.map((paragraph, index) => (
        <TraceNote key={`${index}-${paragraph.slice(0, 24)}`} className="whitespace-pre-wrap">
          {paragraph}
        </TraceNote>
      ))}
    </Trace>
  );
}

function PlanPart({ title, steps }: { title?: string; steps: PlanStep[] }) {
  const done = steps.filter((step) => step.status === "done").length;

  return (
    <div>
      {/* The counter belongs to the title. Without the box that used to bound it, pushing it to the
          container edge would read as a caption on whatever sits alongside. */}
      <div className="flex items-baseline gap-2">
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
    <p className="tf-trace-row flex items-center gap-2.5 py-1 text-sm">
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
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Sources
      </h3>
      <ul>
        {sources.map((source, index) => {
          const internal = source.url?.startsWith("/") === true;
          return (
            <li key={source.id ?? source.url ?? `${source.title ?? "source"}-${index}`}>
              <TraceSource
                title={source.title ?? source.url ?? "Source"}
                href={source.url}
                // A knowledge path is more use than its host, which is always this instance.
                host={source.path ?? sourceHost(source.url)}
                ref={source.ref}
                icon={internal ? BookOpen : ExternalLink}
                as={internal ? Link : undefined}
              />
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
      // A lone part still draws as a run of one, so this switch and the transcript's grouping
      // cannot disagree about what a Tool call looks like.
      return (
        <ToolTrace
          parts={[part]}
          pending={streaming === true && part.status === "running"}
          foldable={false}
          onApprove={onApprove}
        />
      );
    case "plan":
      return <PlanPart title={part.title} steps={part.steps} />;
    case "task":
      return <TaskPart label={part.label} status={part.status} />;
    case "sources":
      return <SourcesPart sources={part.sources} />;
    case "agent-handoff":
      return (
        <p className="tf-trace-row flex items-center gap-2 py-1 text-sm">
          <ArrowRightLeft aria-hidden className="size-3.5 shrink-0 text-run-active" />
          <span className="text-muted-foreground">
            Handed off to <span className="text-foreground">{part.to}</span>
            {part.reason ? <span> · {part.reason}</span> : null}
          </span>
        </p>
      );
    case "guardrail":
      return (
        // A refusal is the loudest thing a Turn can say, and it still earns that from tone, not
        // chrome. Boxing it would outrank the approval ask, which has no box at all.
        <p className="tf-trace-row flex items-start gap-2 py-1 text-sm">
          <ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-run-blocked" />
          <span className="min-w-0">
            <span className="font-medium text-run-blocked">Blocked</span>{" "}
            <span className="text-foreground">{part.message ?? part.reason}</span>
          </span>
        </p>
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
