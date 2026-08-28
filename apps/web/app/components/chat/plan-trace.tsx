import { Waypoints } from "lucide-react";
import { Fragment, useState } from "react";
import { LOADER_LABELS, pick } from "~/components/ui/loading-state";
import { Trace, TraceStep } from "~/components/ui/trace";
import type { PlannedCall, PlannedRound } from "./timeline-groups";
import { ToolStepRow } from "./tool-step";

/**
 * The plan the Agent declared for a Turn, ticked off against what it actually ran.
 *
 * The rounds are the Agent's claim; the ticks are not. Progress is derived in
 * `derivePlanProgress` from the real Tool parts beside this block, so a plan can show work that
 * never happened as still waiting, but can never show work that never happened as done.
 *
 * Each step discloses the real call it was matched to, so the list fills in with evidence as the
 * work lands rather than only flipping glyphs. That is also why the plan is published from the
 * `plan_declare` arguments at dispatch and not from its echoed output: announced on the result it
 * still beat the reads beside it, but by a margin too small to see, so a whole Round went from
 * unstarted to done without ever rendering as in flight.
 *
 * A Round is the Agent's grouping, and on its own says nothing about what ran together: the Agent
 * is not shown which Tools are mutating and the loop serializes those. Where a Round does report
 * concurrency it is measured, off the `batchId` the loop assigned to calls it genuinely dispatched
 * at once — so the heading confirms the forecast rather than repeating it.
 *
 * Every call the Turn made is listed here, in the Round it really ran in — the ones the Agent
 * forecast under its own label, the ones it did not under theirs. A plan that showed only its
 * forecast left the reader with a half-ticked list frozen at Round 1 and a separate pile of
 * unexplained calls below it, which is two accounts of one Turn and no way to line them up.
 *
 * It draws inside the same `Trace` the Tool rows use, so a reply that both plans and works reads
 * as one voice rather than two competing panels. Folding follows that primitive's policy: open
 * while the work is live, folded to its one-line header once it is over, and whatever the reader
 * chose thereafter.
 */
export function PlanTrace({
  rounds,
  pending,
}: {
  rounds: readonly PlannedRound[];
  pending: boolean;
}) {
  const [betweenCallsLabel] = useState(() => pick(LOADER_LABELS));
  const calls = rounds.flatMap((round) => round.calls);
  const planned = calls.filter((call) => call.unplanned !== true);
  const unplanned = calls.length - planned.length;
  const done = calls.filter((call) => call.status === "done").length;
  const failed = calls.filter((call) => call.status === "failed").length;
  const skipped = calls.filter((call) => call.status === "skipped").length;
  const working =
    pending || calls.some((call) => call.status === "running" || call.status === "pending");
  const declared = rounds.filter((round) => round.declared).length;

  // The live edge of the plan: the first step that has not started. While the Turn is working but
  // no call is in flight, a row goes here saying so.
  //
  // Without it the list is a column of empty circles for as long as the Agent takes to think, and
  // the reader cannot tell a Turn that is deciding what to do next from one that has stalled. It
  // is not decoration for a gap that never happens: an Agent that declares its plan in a message
  // of its own — which the Tool asks it not to do, but which it still does — spends a whole model
  // round-trip there, and that is exactly where the reader is left staring at nothing.
  const liveAt = calls.findIndex((call) => call.status === "pending");
  const thinking = pending && !calls.some((call) => call.status === "running");

  const settledLabel = [
    `Planned ${planned.length} steps in ${declared} rounds`,
    // Counted apart from the plan, never folded into it. These rows are in the list because they
    // are work that happened, but calling them planned would credit the Agent with a forecast it
    // did not make.
    ...(unplanned === 0 ? [] : [`${unplanned} unplanned`]),
    ...(failed === 0 ? [] : [`${failed} failed`]),
    // Named rather than hidden: a step the Agent said it would take and then did not is a fact
    // about the Turn. It says "not run" and not "not needed", because the trace knows the call
    // never happened but has no way to know whether it turned out to be unnecessary.
    ...(skipped === 0 ? [] : [`${skipped} not run`]),
  ].join(" · ");

  // Where each Round starts in the flat step order, so the reveal paces across the whole list
  // rather than restarting at every Round heading.
  const offsets: number[] = [];
  let seen = 0;
  for (const round of rounds) {
    offsets.push(seen);
    seen += round.calls.length;
  }

  return (
    <Trace
      icon={Waypoints}
      activeLabel={`Working through the plan · ${done} of ${calls.length}`}
      settledLabel={settledLabel}
      tone={failed === 0 ? undefined : "error"}
      working={working}
      showElapsed={false}
    >
      {rounds.map((round, index) => (
        // Rounds are positional and have no identity of their own; a revision replaces the whole
        // plan, so there is no reordering for a key to survive.
        <div key={index} className="flex flex-col gap-0.5 pt-1 first:pt-0">
          <p className="text-xs text-muted-foreground">
            {round.declared ? `Round ${index + 1}` : "Also ran"}
            {round.atOnce === undefined ? null : (
              <span className="text-muted-foreground/70">{` · ${round.atOnce} at the same time`}</span>
            )}
          </p>
          {round.calls.map((call, callIndex) => {
            const position = (offsets[index] ?? 0) + callIndex;
            return (
              <Fragment key={call.part?.toolCallId ?? `${call.tool}-${callIndex}`}>
                {thinking && position === liveAt ? (
                  <TraceStep status="running" label={betweenCallsLabel} />
                ) : null}
                <PlanCallRow call={call} position={position} />
              </Fragment>
            );
          })}
        </div>
      ))}
      {/* Every step has started, so the edge is past the end of the list rather than inside it. */}
      {thinking && liveAt === -1 ? <TraceStep status="running" label={betweenCallsLabel} /> : null}
      <span className="sr-only">{`${done} of ${calls.length} steps finished`}</span>
    </Trace>
  );
}

/**
 * One line of the to-do list: what the Agent said it would do, and what actually happened when it
 * did it.
 *
 * A step the Agent declared keeps the Agent's own words as its label even after the call lands,
 * because that is the promise the reader is checking off, and discloses the real call underneath.
 * A step the Agent never declared is labelled by the call itself — there is no promise to show —
 * and both draw through the same `ToolStepRow` the run below uses, so absorbing a call into the
 * plan never costs it its result, its panes or its helper trace.
 *
 * A declared step with no matched call has nothing to disclose and stays flat, rather than
 * offering a chevron onto an empty panel.
 *
 * `position` paces the reveal. A plan is one event carrying every row, unlike Tool rows which
 * arrive one at a time and get their pacing from the work itself — so without this the whole list
 * lands in a single paint, and the reader who waited through a model round-trip sees it appear
 * fully drawn with its first Round already ticked. The delay changes when a row is drawn and
 * never what it says: Round 1's reads settle in tens of milliseconds, which is far too fast to
 * watch, so the honest thing to pace is the drawing and not the status.
 */
function PlanCallRow({ call, position }: { call: PlannedCall; position: number }) {
  return (
    <div
      className="tf-plan-row"
      // Capped so a long plan still finishes drawing promptly rather than trickling.
      style={{ animationDelay: `${Math.min(position * 55, 550)}ms` }}
    >
      {call.part === undefined ? (
        <TraceStep
          status="pending"
          label={call.label ?? call.tool}
          value={call.tool}
          mono
          // A step that was planned and then never ran is spent, not waiting; dimming it says so
          // without spending a fifth glyph on a state the reader meets once in a while.
          className={call.status === "skipped" ? "opacity-50" : undefined}
        />
      ) : (
        <ToolStepRow
          part={call.part}
          label={call.unplanned === true ? undefined : (call.label ?? call.tool)}
        />
      )}
    </div>
  );
}
