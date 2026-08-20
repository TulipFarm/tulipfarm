import type { TimelinePart } from "~/lib/chat/types";
import { isHiddenToolPart, isPresentationToolPart } from "./tool-summary";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

/**
 * Grouping still applies at any length — that is presentation, not concealment.
 *
 * Folding starts at two because that is where the header starts saying more than the rows it
 * hides: `Ran 2 tools` is a summary, while `Ran 1 tool` is strictly less than the one line it
 * would replace. A settled run left open is chrome above the answer, which is the cost the whole
 * trace exists to avoid.
 */
export const MIN_CLUSTER_SIZE = 2;

export type TimelineNode =
  | { kind: "part"; part: TimelinePart; index: number }
  | { kind: "surface-building"; index: number }
  | {
      kind: "tool-run";
      parts: ToolPart[];
      index: number;
      foldable: boolean;
    };

/**
 * A step that can hide under a folded header without misreporting it.
 *
 * A failure qualifies: the fold header carries its own failure count, so folding one no longer
 * hides that something went wrong — it costs a click to read the detail, which is the same price
 * every other settled step pays. An approval does not: that is an ask, and hiding an ask behind a
 * click strands the reader waiting on a decision they cannot see.
 */
function isFoldable(part: ToolPart): boolean {
  if (part.status !== "done") return false;
  if (part.approval !== undefined) return false;
  return true;
}

/**
 * A run containing the live trailing part is never folded: that part is the edge of the turn,
 * and folding it would make the transcript look finished before it is.
 */
export function groupTimelineParts(
  parts: readonly TimelinePart[],
  options?: { streaming?: boolean }
): TimelineNode[] {
  const visible: { part: TimelinePart; index: number }[] = [];
  let building: number | undefined;
  parts.forEach((part, index) => {
    if (part.kind === "tool" && isHiddenToolPart(part)) {
      // A presentation Tool has no row, but while it is in flight the reader is owed something:
      // the reply is visibly building its own UI, and silence reads as a stalled turn.
      if (isPresentationToolPart(part) && part.status !== "done") building = index;
      return;
    }
    visible.push({ part, index });
  });

  const lastVisibleIndex = visible.length - 1;
  const nodes: TimelineNode[] = [];
  let run: { part: ToolPart; index: number }[] = [];
  let runHasLive = false;

  const flush = () => {
    const [first] = run;
    if (first === undefined) return;
    const foldable =
      run.length >= MIN_CLUSTER_SIZE && !runHasLive && run.every((entry) => isFoldable(entry.part));
    nodes.push({
      kind: "tool-run",
      parts: run.map((entry) => entry.part),
      index: first.index,
      foldable,
    });
    run = [];
    runHasLive = false;
  };

  visible.forEach((entry, position) => {
    if (entry.part.kind === "tool") {
      run.push({ part: entry.part, index: entry.index });
      if (options?.streaming === true && position === lastVisibleIndex) runHasLive = true;
      return;
    }
    flush();
    nodes.push({ kind: "part", part: entry.part, index: entry.index });
  });
  flush();

  if (building !== undefined) nodes.push({ kind: "surface-building", index: building });

  return nodes;
}
