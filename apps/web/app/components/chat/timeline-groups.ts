import type { TimelinePart } from "~/lib/chat/types";
import { isHiddenToolPart } from "./tool-summary";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

/** Grouping still applies at any length — that is presentation, not concealment. */
export const MIN_CLUSTER_SIZE = 3;

export type TimelineNode =
  | { kind: "part"; part: TimelinePart; index: number }
  | {
      kind: "tool-run";
      parts: ToolPart[];
      index: number;
      foldable: boolean;
    };

function isFoldable(part: ToolPart): boolean {
  if (part.status !== "done") return false;
  if (part.outcome === "error") return false;
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
  parts.forEach((part, index) => {
    if (part.kind === "tool" && isHiddenToolPart(part)) return;
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

  return nodes;
}
