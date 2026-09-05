import { Fragment, useState } from "react";
import { LOADER_LABELS, pick } from "~/components/ui/loading-state";
import { Trace, TraceStep } from "~/components/ui/trace";
import type { TimelinePart } from "~/lib/chat/types";
import { type FileDraftResult, fileDraftOf } from "./file-draft-card";
import { concurrentRuns, largestConcurrentRun } from "./timeline-groups";
import { ToolStepRow } from "./tool-step";
import { describeToolCallActive, summarizeToolCall } from "./tool-summary";

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
  onReviseDraft,
}: {
  parts: readonly ToolPart[];
  pending: boolean;
  foldable: boolean;
  onApprove: (approvalId: string, decision: "approve" | "deny") => void;
  onReviseDraft?: (draft: FileDraftResult) => void;
}) {
  const [betweenCallsLabel] = useState(() => pick(LOADER_LABELS));
  const settled = parts.filter((part) => part.status === "done").length;
  const failed = parts.filter((part) => part.status === "done" && part.outcome === "error").length;
  const countLabel = `Ran ${parts.length} ${parts.length === 1 ? "tool" : "tools"}`;
  // The rows carry concurrency, and folding hides the rows — so the header has to carry it too, or
  // the fact only exists while the run happens to be open.
  const atOnce = largestConcurrentRun(parts);
  const settledLabel = [
    countLabel,
    ...(atOnce === undefined ? [] : [`${atOnce} at the same time`]),
    ...(failed === 0 ? [] : [`${failed} failed`]),
  ].join(" · ");
  const concurrent = concurrentRuns(parts);
  const running = parts.find((part) => part.status === "running");
  const activeLabel =
    running === undefined
      ? "Working"
      : (describeToolCallActive(summarizeToolCall(running)) ?? "Running tools");

  return (
    <Trace
      activeLabel={activeLabel}
      // The count is why a failed run is allowed to fold at all: it reports the failure on the one
      // line that survives, so folding costs the reader a click, never the fact.
      settledLabel={settledLabel}
      tone={failed === 0 ? undefined : "error"}
      working={pending || running !== undefined}
      // Folding is about attention, not evidence. A run below three steps saves nothing by
      // collapsing, and a run still holding an approval is an ask the reader must be able to see.
      keepOpen={!foldable || parts.some((part) => fileDraftOf(part) !== undefined)}
      // The header already names the call in flight, and each row carries its own duration; a
      // second timer beside it would be the same clock twice.
      showElapsed={false}
    >
      {parts.map((part, index) => {
        const startsBatch = concurrent.get(index);
        return (
          <Fragment key={part.toolCallId}>
            {/*
             * One caption above the steps the runtime really did run together. Said in the
             * reader's words rather than the runtime's — nobody has to know what a Tool is to
             * understand that several things happened at once instead of one after another.
             */}
            {startsBatch === undefined ? null : (
              <p className="pt-1 text-xs text-muted-foreground">{`${startsBatch} at the same time`}</p>
            )}
            <ToolStepRow part={part} onApprove={onApprove} onReviseDraft={onReviseDraft} />
          </Fragment>
        );
      })}
      {/*
       * The live edge between calls. No Tool is in flight, so there is no name to show — but the
       * Turn is still working, and a row that says so is the difference between following along
       * and watching a static list of ticks until the next result snaps in already finished.
       */}
      {pending && running === undefined ? (
        <TraceStep status="running" label={betweenCallsLabel} />
      ) : null}
      {/* Progress the reader can check against the rows above, not a claim the trace cannot back. */}
      <span className="sr-only">{`${settled} of ${parts.length} finished`}</span>
    </Trace>
  );
}
