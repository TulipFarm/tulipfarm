import { PenLine } from "~/components/icons";
import { Link } from "~/components/ui/link";
import { TraceStep } from "~/components/ui/trace";
import type { TimelinePart } from "~/lib/chat/types";
import { useIsAdmin } from "~/lib/use-session-user";
import { ApprovalCard } from "./approval-card";
import { FileDraftCard, type FileDraftResult, fileDraftOf } from "./file-draft-card";
import { SubagentPanel, traceOf } from "./subagent-panel";
import { ToolInspector, toolHasDetails } from "./tool-inspector";
import {
  describeToolCallActive,
  describeToolResult,
  formatDuration,
  summarizeToolCall,
} from "./tool-summary";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

/**
 * One Tool call, drawn the same way wherever it is listed.
 *
 * A call can appear in a run of Tool rows or inside the plan that forecast it, and the reader
 * should not be able to tell which list they are looking at from how much a row will tell them.
 * Before this was shared, a call absorbed into the plan lost its Input/Output panes, its helper
 * trace and its connect link — the plan tidied the transcript by quietly discarding evidence.
 *
 * `label` is the one thing a caller may override, and only to substitute the Agent's own words for
 * a step it said it would take, because that is the promise the reader is checking off. The real
 * call is then disclosed underneath rather than dropped, so a label can never stand in for what
 * actually ran. Every other fact comes off the part.
 */
export function ToolStepRow({
  part,
  label,
  className,
  onApprove,
  onReviseDraft,
}: {
  part: ToolPart;
  label?: string;
  className?: string;
  onApprove?: (approvalId: string, decision: "approve" | "deny") => void;
  onReviseDraft?: (draft: FileDraftResult) => void;
}) {
  const ran = summarizeToolCall(part);
  const status = part.status === "running" ? "running" : outcomeOf(part);
  const approval = part.approval;
  const fileDraft = fileDraftOf(part);
  const isAdmin = useIsAdmin();
  return (
    <>
      <TraceStep
        status={status}
        label={label ?? ran}
        // Only a row labelled by the call itself can restate that label in the present tense. A
        // planned step's label is a promise, and promises do not have a running form.
        activeLabel={label === undefined ? describeToolCallActive(ran) : undefined}
        value={part.toolName}
        mono
        className={className}
        marker={
          part.meta?.mutating === true ? (
            <PenLine
              aria-label="This tool can write"
              className="size-3 shrink-0 text-tool-mutating"
            />
          ) : undefined
        }
        detail={detailOf(part, status, isAdmin, label === undefined ? undefined : ran)}
      />
      {/*
       * The one thing a step may not hide behind its own disclosure. Everything else in a trace is
       * evidence the reader can take or leave; this is a question addressed to them, and a question
       * they have to click to find is a question they will miss.
       */}
      {approval === undefined || onApprove === undefined ? null : (
        <div className="py-1">
          <ApprovalCard
            toolName={part.toolName}
            approval={approval}
            onDecide={(decision) => onApprove(approval.approvalId, decision)}
          />
        </div>
      )}
      {fileDraft === undefined ? null : (
        <FileDraftCard draft={fileDraft} onRevise={onReviseDraft} />
      )}
    </>
  );
}

/**
 * What the step actually did. The one-line facts come from the payload — a step with nothing to
 * report stays silent and non-expandable rather than offering a chevron onto an empty panel — and
 * the verbatim Input/Output panes follow, so a chrome-free step still discloses every fact.
 *
 * `ran` is passed only when the row's label came from somewhere other than the call, in which case
 * the call's own summary leads the disclosure.
 */
function detailOf(
  part: ToolPart,
  status: "running" | "done" | "error",
  isAdmin: boolean,
  ran?: string
) {
  const code = status === "error" ? part.meta?.errorCode : undefined;
  const hint = status === "done" ? describeToolResult(part) : undefined;
  const duration = formatDuration(part.meta?.durationMs);
  const inspectable = toolHasDetails(part);
  const connectUrl = status === "error" ? part.meta?.connectUrl : undefined;
  const subagent = traceOf(part);
  if (
    ran === undefined &&
    code === undefined &&
    hint === undefined &&
    duration === undefined &&
    connectUrl === undefined &&
    subagent === undefined &&
    !inspectable
  ) {
    return undefined;
  }
  return (
    <div className="space-y-2">
      {ran === undefined &&
      code === undefined &&
      hint === undefined &&
      duration === undefined ? null : (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {ran === undefined ? null : (
            <span className={status === "running" ? "tf-loader-label" : undefined}>
              {status === "running" ? (describeToolCallActive(ran) ?? ran) : ran}
            </span>
          )}
          {code === undefined ? null : <span className="font-mono text-run-error">{code}</span>}
          {hint === undefined ? null : <span>{hint}</span>}
          {duration === undefined ? null : (
            <span className="font-mono tabular-nums">{duration}</span>
          )}
        </span>
      )}
      {connectUrl === undefined ? null : isSecretsUrl(connectUrl) && !isAdmin ? (
        <p className="text-muted-foreground">Ask an administrator to add this Credential.</p>
      ) : (
        <Link
          to={connectUrl}
          className="block text-foreground underline decoration-border underline-offset-[3px] transition-colors hover:decoration-foreground"
        >
          {isSecretsUrl(connectUrl) ? "Add the required Credential →" : "Connect your account →"}
        </Link>
      )}
      {/*
       * Above the verbatim panes, not inside them. A helper's work is the substance of this step,
       * whereas Input/Output are the evidence behind it, and a reader should not have to read JSON
       * to find out what ran on their behalf.
       */}
      {subagent === undefined ? null : <SubagentPanel part={part} />}
      {inspectable ? <ToolInspector part={part} /> : null}
    </div>
  );
}

function outcomeOf(part: ToolPart): "done" | "error" {
  return part.outcome === "error" ? "error" : "done";
}

function isSecretsUrl(connectUrl: string): boolean {
  return connectUrl.startsWith("/business/secrets");
}
