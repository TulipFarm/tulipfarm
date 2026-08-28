import type { PlanRound, TimelinePart } from "~/lib/chat/types";
import { isHiddenToolPart, isPresentationToolPart, PLAN_TOOL_NAME } from "./tool-summary";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

/**
 * What the trace can honestly say about a call the Agent said it would make.
 *
 * `skipped` is only ever reached once the Turn has stopped streaming: while work is still in
 * flight, a call that has not started is `pending`, and calling it skipped would be a guess.
 */
export type PlannedCallStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type PlannedCall = {
  tool: string;
  label?: string;
  status: PlannedCallStatus;
  /**
   * The real Tool call this step was matched to, so the step can report what actually ran rather
   * than only that something did. Absent while the step is `pending` or `skipped`, which is the
   * same thing as saying no real call has been claimed for it.
   */
  part?: ToolPart;
  /**
   * True when no declared step claimed this call: the Agent ran it without saying it would. Such a
   * row still belongs in the list — it is work that happened — but it is labelled by the call
   * itself, never by a promise, because there was no promise.
   */
  unplanned?: true;
};
export type PlannedRound = {
  calls: PlannedCall[];
  /**
   * How many of this Round's steps the runtime really did dispatch together, read off the
   * `batchId` its matched parts share. Measured, never forecast: the Agent is not shown which
   * Tools are mutating and the loop serializes those, so a Round of four can still run one at a
   * time. Absent unless at least two matched parts genuinely shared a batch.
   */
  atOnce?: number;
  /**
   * Whether the Agent declared this Round. A Round that carries only work the plan never mentioned
   * is real but unforecast, and must not be numbered as though the Agent had called it.
   */
  declared: boolean;
};

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
  | { kind: "plan"; rounds: PlannedRound[]; index: number }
  | {
      kind: "tool-run";
      parts: ToolPart[];
      index: number;
      foldable: boolean;
    };

/**
 * Tick a declared plan off against the calls that actually happened, and fold those calls in.
 *
 * The Agent declares the *shape*; this derives the *progress*, and only from real Tool parts.
 * Nothing here can mark a call done that the Turn did not run: a tick means a call to that Tool
 * happened, and the worst it can do is leave a call that did run looking pending, which is the
 * safe direction for a trace to be wrong in.
 *
 * It runs in two passes, because a plan is a forecast and an Agent is free to depart from it.
 *
 * First, each declared step is matched to the earliest unclaimed Tool call of that name, so the
 * same Tool planned twice consumes two real calls rather than both pointing at one. The bound
 * worth knowing is that a tick attests to the Tool, not to the Agent's label for it: the wire
 * carries only a digest of a call's arguments, so two calls to one Tool are indistinguishable
 * here. Every matched step therefore discloses the real call underneath, which is where the reader
 * checks a label rather than taking it on trust.
 *
 * Second, every call no step claimed is placed in the Round it really ran in. Work is dispatched in
 * waves — a `batchId` the loop assigns to calls it fires together, or a wave of one for a call it
 * had to serialize — and a wave no declared Round accounts for belongs to the Round that was
 * current when it ran: the earliest Round that has not started. Waves past the end of the plan
 * become one undeclared Round at the bottom.
 *
 * That second pass is the difference between a to-do list and a forecast with a separate feed
 * underneath it. Without it, an Agent that departed from its own plan left a half-ticked list
 * frozen at Round 1 while a pile of unexplained calls accumulated below — the reader could see
 * both, and could not see that they were the same Turn.
 */
export function derivePlanProgress(
  rounds: readonly PlanRound[],
  parts: readonly TimelinePart[],
  options?: { streaming?: boolean }
): PlannedRound[] {
  const tools = parts.filter((part): part is ToolPart => part.kind === "tool").filter(isAbsorbable);
  const claimed = new Set<number>();
  const unstarted: PlannedCallStatus = options?.streaming === true ? "pending" : "skipped";

  const declared = rounds.map((round) =>
    round.calls.map((call): PlannedCall => {
      const at = tools.findIndex((part, i) => !claimed.has(i) && part.toolName === call.tool);
      const label = call.label === undefined ? {} : { label: call.label };
      const part = at === -1 ? undefined : tools[at];
      if (part === undefined) return { tool: call.tool, ...label, status: unstarted };
      claimed.add(at);
      return { tool: call.tool, ...label, status: statusOf(part), part };
    })
  );

  const waves = toolWaves(tools);
  const waveAt = new Map<string, number>();
  waves.forEach((wave, index) => {
    for (const part of wave) waveAt.set(part.toolCallId, index);
  });
  const claimedIds = new Set(
    declared.flatMap((calls) =>
      calls.flatMap((call) => (call.part === undefined ? [] : [call.part.toolCallId]))
    )
  );
  const waveOfCall = (call: PlannedCall) =>
    call.part === undefined ? undefined : waveAt.get(call.part.toolCallId);
  // Whether a Round had finished dispatching by the time this wave ran. Judged only against waves
  // up to that point, never the whole Turn: a Round whose step lands three waves later has not
  // finished yet, and treating it as finished is what used to make rows jump Rounds mid-Turn.
  const settledBy = (wave: number, round: number) =>
    (declared[round] ?? []).every((call) => {
      const at = waveOfCall(call);
      return at !== undefined && at <= wave;
    });
  const extra = new Map<number, ToolPart[]>();
  const beyond: ToolPart[] = [];
  // The Round the Turn had reached when a wave ran: the earliest one still holding a step that has
  // not been dispatched. It only ever moves forward, and only on evidence from waves already seen,
  // so a row placed in a Round stays in that Round for the rest of the Turn — a to-do list that
  // reshuffles itself under the reader is one they cannot follow.
  //
  // Deliberately not "the Round whose steps shared this wave". Matching is by Tool name, so an
  // early exploratory call can be claimed by a step the Agent meant for much later; reading the
  // Round off that match jumped the list to Round 4 while Round 2 had not started, and took every
  // unforecast call with it.
  let current = 0;
  waves.forEach((wave, index) => {
    const orphans = wave.filter((part) => !claimedIds.has(part.toolCallId));
    if (orphans.length > 0) {
      if (current < declared.length) {
        extra.set(current, [...(extra.get(current) ?? []), ...orphans]);
      } else beyond.push(...orphans);
    }
    while (current < declared.length && settledBy(index, current)) current += 1;
  });

  const built = declared.map((calls, index) =>
    roundOf([...calls, ...(extra.get(index) ?? []).map(asUnplanned)], true)
  );
  return beyond.length === 0 ? built : [...built, roundOf(beyond.map(asUnplanned), false)];
}

/**
 * Whether a Tool row can move inside the plan without the reader losing it.
 *
 * An approval stays out. A settled plan folds to its one-line header, and a question the reader
 * has to unfold is a question they will miss — so an ask keeps a row of its own that no fold
 * policy can swallow. Hidden and presentation Tools have no row to absorb in the first place:
 * their output already renders as the thing they produced. The plan's own `plan_declare` call is
 * never absorbed either, since a plan cannot list the act of declaring itself.
 */
function isAbsorbable(part: ToolPart): boolean {
  if (part.approval !== undefined) return false;
  if (part.toolName === PLAN_TOOL_NAME) return false;
  return !isHiddenToolPart(part) && !isPresentationToolPart(part);
}

/**
 * The waves of work a Turn really dispatched, in order.
 *
 * A wave is a `batchId` the loop assigned to calls it fired together. A call without one ran
 * alone as far as this reader can tell — the loop serializes mutating calls — so it forms a wave
 * of its own rather than being merged into whatever happened to sit beside it.
 */
function toolWaves(tools: readonly ToolPart[]): ToolPart[][] {
  const waves: ToolPart[][] = [];
  let openId: string | undefined;
  for (const part of tools) {
    const id = part.meta?.batchId;
    const open = waves.at(-1);
    if (open !== undefined && id !== undefined && id === openId) {
      open.push(part);
      continue;
    }
    waves.push([part]);
    openId = id;
  }
  return waves;
}

function roundOf(calls: PlannedCall[], declared: boolean): PlannedRound {
  const atOnce = largestConcurrentRun(
    calls.flatMap((call) => (call.part === undefined ? [] : [call.part]))
  );
  return { calls, declared, ...(atOnce === undefined ? {} : { atOnce }) };
}

function asUnplanned(part: ToolPart): PlannedCall {
  return { tool: part.toolName, status: statusOf(part), part, unplanned: true };
}

function statusOf(part: ToolPart): PlannedCallStatus {
  if (part.status !== "done") return "running";
  return part.outcome === "error" ? "failed" : "done";
}

/**
 * The Tool calls a plan has already accounted for, so nothing is reported twice.
 *
 * A planned step now discloses the call that satisfied it — what ran, what came back, how long it
 * took — which makes a second row for that same call below the plan the same fact told twice. The
 * reader saw exactly that: a to-do list, and then a duplicate list underneath with the same items
 * ticked. Calls the plan never claimed still get their own rows; they are work the Agent did
 * without saying it would, which is precisely what the reader has no other way to find out.
 */
export function planClaimedCallIds(parts: readonly TimelinePart[]): Set<string> {
  const plan = parts.find((part) => part.kind === "plan");
  if (plan === undefined) return new Set();
  return new Set(
    derivePlanProgress(plan.rounds, parts)
      .flatMap((round) => round.calls)
      .flatMap((call) => (call.part === undefined ? [] : [call.part.toolCallId]))
  );
}

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
  const claimed = planClaimedCallIds(parts);
  parts.forEach((part, index) => {
    if (part.kind === "tool" && (isHiddenToolPart(part) || claimed.has(part.toolCallId))) {
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
    if (entry.part.kind === "plan") {
      nodes.push({
        kind: "plan",
        rounds: derivePlanProgress(entry.part.rounds, parts, options),
        index: entry.index,
      });
      return;
    }
    nodes.push({ kind: "part", part: entry.part, index: entry.index });
  });
  flush();

  if (building !== undefined) nodes.push({ kind: "surface-building", index: building });

  return nodes;
}

/**
 * Where each concurrent dispatch starts, and how many steps it holds.
 *
 * Read off `meta.batchId`, which the Tool loop sets only when it genuinely dispatched several
 * calls together. Never inferred from adjacency and never from two start times that merely look
 * close: a trace that overstates what happened is worse than one that says less.
 *
 * A batch is keyed by the index of its first step rather than by requiring its steps to be
 * contiguous, because a hidden presentation Tool dispatched alongside them leaves no row. Sizes
 * count the steps actually present, so a lost event makes the trace understate concurrency — the
 * safe direction — rather than keep claiming a sibling that never arrived.
 */
export function concurrentRuns(parts: readonly ToolPart[]): Map<number, number> {
  const sizes = new Map<string, number>();
  const firstAt = new Map<string, number>();
  parts.forEach((part, index) => {
    const id = part.meta?.batchId;
    if (id === undefined) return;
    sizes.set(id, (sizes.get(id) ?? 0) + 1);
    if (!firstAt.has(id)) firstAt.set(id, index);
  });

  const startsAt = new Map<number, number>();
  for (const [id, size] of sizes) {
    const at = firstAt.get(id);
    // One surviving step of a batch ran alone as far as this reader can tell, and saying
    // otherwise would be a claim the trace cannot back.
    if (size >= MIN_CLUSTER_SIZE && at !== undefined) startsAt.set(at, size);
  }
  return startsAt;
}

/** The widest concurrent dispatch in a run, so the fact survives the run folding to one line. */
export function largestConcurrentRun(parts: readonly ToolPart[]): number | undefined {
  const sizes = [...concurrentRuns(parts).values()];
  return sizes.length === 0 ? undefined : Math.max(...sizes);
}
