/**
 * Folds a message's parts into the nodes the transcript actually renders.
 *
 * Consecutive Tool calls are one event in the reader's head — "it went and looked things up" — so
 * they are grouped into a single run and drawn as one block. Rendering each as its own card turned
 * a three-step lookup into three islands of chrome and buried the prose the reader came for.
 *
 * A run that is long enough and asks nothing of anyone can additionally be *folded* to one line.
 * Anything still in flight, awaiting an approval, or failed keeps its row: hiding those is what
 * makes a run feel opaque.
 *
 * Kept free of React so the folding rules can be tested directly.
 */

import type { TimelinePart } from "~/lib/chat/types";
import { isHiddenToolPart } from "./tool-summary";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

/**
 * Below this a fold costs more than it saves: two rows are readable, and collapsing them only adds
 * a click and takes away the detail. Grouping still applies at any length — that is presentation,
 * not concealment.
 */
export const MIN_CLUSTER_SIZE = 3;

export type TimelineNode =
  /** `index` is the part's position in the original array, so React keys stay stable. */
  | { kind: "part"; part: TimelinePart; index: number }
  | {
      kind: "tool-run";
      parts: ToolPart[];
      index: number;
      /** Whether this run may collapse to a single "Ran N tools" line. */
      foldable: boolean;
    };

/**
 * Whether a Tool row may be hidden behind a fold.
 *
 * Only a finished, successful, unattended call qualifies. A pending approval is an ask, an error is
 * evidence, and an open call is still happening — each has to stay on the page in its own right.
 */
function isFoldable(part: ToolPart): boolean {
  if (part.status !== "done") return false;
  if (part.outcome === "error") return false;
  if (part.approval !== undefined) return false;
  return true;
}

/**
 * Groups a message's parts, dropping Tool rows whose output already renders as something else.
 *
 * A run containing the live trailing part is never folded: that part is the edge of the turn, and
 * folding it would make the transcript look finished before it is.
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
