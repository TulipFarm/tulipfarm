import { Link } from "@remix-run/react";
import { PenLine } from "lucide-react";
import { Fragment } from "react";
import { Trace, TraceStep } from "~/components/ui/trace";
import type { TimelinePart } from "~/lib/chat/types";
import { ApprovalCard } from "./approval-card";
import { ToolInspector, toolHasDetails } from "./tool-inspector";
import {
  describeToolCall,
  describeToolCallActive,
  describeToolResult,
  formatDuration,
} from "./tool-summary";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

/**
 * A run of Tool calls — live, settled, failed, or awaiting a decision.
 *
 * This is the only presentation a run gets. It draws as a Trace: chrome-free narration on a rail,
 * live step expanded, settled steps folded back to one line, the whole run folded to its header
 * once the work is over. The bordered record it replaced said the same things inside a box, which
 * made every reply that touched a Tool open with a slab of chrome above the answer.
 *
 * An approval is the one thing that does not hide. It renders as a card between the steps, always
 * visible, and its run never folds — a question the reader has to hunt for is a question they miss.
 *
 * `pending` says this run is still the live edge of the Turn — nothing has come after it yet.
 * Without it the trace would be a column of finished ticks for seconds at a time, because a
 * platform Tool returns in ~20ms while the model round-trip between calls takes far longer. Once
 * anything follows the run, the work it describes is over and the trace folds to its header.
 */
export function ToolTrace({
  parts,
  pending,
  foldable,
  onApprove,
}: {
  parts: readonly ToolPart[];
  pending: boolean;
  foldable: boolean;
  onApprove: (approvalId: string, decision: "approve" | "deny") => void;
}) {
  const settled = parts.filter((part) => part.status === "done").length;
  const failed = parts.filter((part) => part.status === "done" && part.outcome === "error").length;
  const countLabel = `Ran ${parts.length} ${parts.length === 1 ? "tool" : "tools"}`;
  const running = parts.find((part) => part.status === "running");
  const activeLabel =
    running === undefined
      ? "Working"
      : (describeToolCallActive(summaryOf(running)) ?? "Running tools");

  return (
    <Trace
      activeLabel={activeLabel}
      // The count is why a failed run is allowed to fold at all: it reports the failure on the one
      // line that survives, so folding costs the reader a click, never the fact.
      settledLabel={failed === 0 ? countLabel : `${countLabel} · ${failed} failed`}
      tone={failed === 0 ? undefined : "error"}
      working={pending || running !== undefined}
      // Folding is about attention, not evidence. A run below three steps saves nothing by
      // collapsing, and a run still holding an approval is an ask the reader must be able to see.
      keepOpen={!foldable}
      // The header already names the call in flight, and each row carries its own duration; a
      // second timer beside it would be the same clock twice.
      showElapsed={false}
    >
      {parts.map((part) => {
        const label = summaryOf(part);
        const status = part.status === "running" ? "running" : outcomeOf(part);
        const approval = part.approval;
        return (
          <Fragment key={part.toolCallId}>
            <TraceStep
              status={status}
              label={label}
              activeLabel={describeToolCallActive(label)}
              value={part.toolName}
              mono
              marker={
                part.meta?.mutating === true ? (
                  <PenLine
                    aria-label="This tool can write"
                    className="size-3 shrink-0 text-tool-mutating"
                  />
                ) : undefined
              }
              detail={detailOf(part, status)}
            />
            {/*
             * The one thing a step may not hide behind its own disclosure. Everything else in a
             * trace is evidence the reader can take or leave; this is a question addressed to them,
             * and a question they have to click to find is a question they will miss.
             */}
            {approval === undefined ? null : (
              <div className="py-1">
                <ApprovalCard
                  toolName={part.toolName}
                  approval={approval}
                  onDecide={(decision) => onApprove(approval.approvalId, decision)}
                />
              </div>
            )}
          </Fragment>
        );
      })}
      {/*
       * The live edge between calls. No Tool is in flight, so there is no name to show — but the
       * Turn is still working, and a row that says so is the difference between following along
       * and watching a static list of ticks until the next result snaps in already finished.
       */}
      {pending && running === undefined ? <TraceStep status="running" label="Thinking" /> : null}
      {/* Progress the reader can check against the rows above, not a claim the trace cannot back. */}
      <span className="sr-only">{`${settled} of ${parts.length} finished`}</span>
    </Trace>
  );
}

/**
 * What the step actually did. The one-line facts come from the payload — a step with nothing to
 * report stays silent and non-expandable rather than offering a chevron onto an empty panel — and
 * the verbatim Input/Output panes follow, so a chrome-free step still discloses every fact.
 */
function detailOf(part: ToolPart, status: "running" | "done" | "error") {
  const code = status === "error" ? part.meta?.errorCode : undefined;
  const hint = status === "done" ? describeToolResult(part) : undefined;
  const duration = formatDuration(part.meta?.durationMs);
  const inspectable = toolHasDetails(part);
  const connectUrl = status === "error" ? part.meta?.connectUrl : undefined;
  if (
    code === undefined &&
    hint === undefined &&
    duration === undefined &&
    connectUrl === undefined &&
    !inspectable
  ) {
    return undefined;
  }
  return (
    <div className="space-y-2">
      {code === undefined && hint === undefined && duration === undefined ? null : (
        <span className="flex items-center gap-2">
          {code === undefined ? null : <span className="font-mono text-run-error">{code}</span>}
          {hint === undefined ? null : <span>{hint}</span>}
          {duration === undefined ? null : (
            <span className="font-mono tabular-nums">{duration}</span>
          )}
        </span>
      )}
      {connectUrl === undefined ? null : (
        <Link to={connectUrl} className="block text-primary hover:underline">
          {connectUrl.startsWith("/business/secrets")
            ? "Add the required Credential →"
            : "Connect your account →"}
        </Link>
      )}
      {inspectable ? <ToolInspector part={part} /> : null}
    </div>
  );
}

function summaryOf(part: ToolPart): string {
  return describeToolCall(part.toolName, argsOf(part), part.meta?.summary);
}

/** The redacted preview is authoritative; the raw arguments are the fallback. */
function argsOf(part: ToolPart): unknown {
  if (part.argsPreview === undefined) return part.args;
  try {
    return JSON.parse(part.argsPreview.json);
  } catch {
    return part.args;
  }
}

function outcomeOf(part: ToolPart): "done" | "error" {
  return part.outcome === "error" ? "error" : "done";
}
