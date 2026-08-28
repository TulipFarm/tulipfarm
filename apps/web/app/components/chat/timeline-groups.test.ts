import { describe, expect, it } from "vitest";
import type { TimelinePart } from "~/lib/chat/types";
import {
  concurrentRuns,
  derivePlanProgress,
  groupTimelineParts,
  largestConcurrentRun,
  MIN_CLUSTER_SIZE,
} from "./timeline-groups";

function tool(overrides: Partial<Extract<TimelinePart, { kind: "tool" }>> = {}): TimelinePart {
  return {
    kind: "tool",
    toolCallId: Math.random().toString(36).slice(2),
    toolName: "search_docs",
    status: "done",
    result: { success: true },
    ...overrides,
  } as TimelinePart;
}

const text: TimelinePart = { kind: "text", text: "hello" };

/** Narrow to a run node so assertions read without repeating the discriminant check. */
function run(node: ReturnType<typeof groupTimelineParts>[number]) {
  if (node.kind !== "tool-run") throw new Error(`expected a tool-run, got ${node.kind}`);
  return node;
}

describe("groupTimelineParts", () => {
  it("gathers consecutive calls into one run and marks a long settled one foldable", () => {
    const nodes = groupTimelineParts([tool(), tool(), tool()]);

    expect(nodes).toHaveLength(1);
    expect(run(nodes[0]).parts).toHaveLength(3);
    expect(run(nodes[0]).foldable).toBe(true);
  });

  it("still groups a run too short to fold, so it draws as one block", () => {
    const nodes = groupTimelineParts(Array.from({ length: MIN_CLUSTER_SIZE - 1 }, () => tool()));

    expect(nodes).toHaveLength(1);
    expect(run(nodes[0]).parts).toHaveLength(MIN_CLUSTER_SIZE - 1);
    expect(run(nodes[0]).foldable).toBe(false);
  });

  it("keeps a failed call in the run and still folds it, because the header counts failures", () => {
    const nodes = groupTimelineParts([tool(), tool(), tool(), tool({ outcome: "error" })]);

    expect(nodes).toHaveLength(1);
    expect(run(nodes[0]).parts).toHaveLength(4);
    expect(run(nodes[0]).foldable).toBe(true);
  });

  it("never folds a run holding a call that is awaiting an approval", () => {
    const held = tool({
      approval: { approvalId: "a1", status: "pending" },
    } as Partial<Extract<TimelinePart, { kind: "tool" }>>);

    expect(run(groupTimelineParts([tool(), tool(), held])[0]).foldable).toBe(false);
  });

  it("never folds a run holding a call that is still running", () => {
    const nodes = groupTimelineParts([tool(), tool(), tool({ status: "running" })]);

    expect(run(nodes[0]).foldable).toBe(false);
  });

  it("keeps the live trailing call out of a fold while the message streams", () => {
    const parts = [tool(), tool(), tool()];

    expect(run(groupTimelineParts(parts, { streaming: true })[0]).foldable).toBe(false);
    expect(run(groupTimelineParts(parts, { streaming: false })[0]).foldable).toBe(true);
  });

  it("does not let a hidden tool row split a run", () => {
    const nodes = groupTimelineParts([tool(), tool({ toolName: "cite_sources" }), tool(), tool()]);

    expect(nodes).toHaveLength(1);
    expect(run(nodes[0]).parts).toHaveLength(3);
  });

  it("keeps prose between runs and preserves original indices for keys", () => {
    const nodes = groupTimelineParts([text, tool(), tool(), tool(), text]);

    expect(nodes.map((node) => node.kind)).toEqual(["part", "tool-run", "part"]);
    expect(nodes[1]?.index).toBe(1);
    expect(nodes[2]?.index).toBe(4);
  });

  it("starts a new run after prose interrupts one", () => {
    const nodes = groupTimelineParts([tool(), tool(), text, tool(), tool()]);

    expect(nodes.map((node) => node.kind)).toEqual(["tool-run", "part", "tool-run"]);
    expect(run(nodes[0]).parts).toHaveLength(2);
    expect(run(nodes[2]).parts).toHaveLength(2);
  });
});

// The threshold is a product boundary, not a tuning knob, so it is asserted with literals: the
// other tests here derive their sizes from MIN_CLUSTER_SIZE and so pass at any value.
describe("the fold boundary", () => {
  it("folds a run of two Tools, where the header says more than the rows it hides", () => {
    const nodes = groupTimelineParts([tool(), tool()]);
    expect(run(nodes[0]).foldable).toBe(true);
  });

  it("leaves a single Tool as itself, since `Ran 1 tool` says less than the row", () => {
    const nodes = groupTimelineParts([tool()]);
    expect(run(nodes[0]).foldable).toBe(false);
  });
});

describe("which steps the runtime ran at the same time", () => {
  it("reports a batch at the index of its first step", () => {
    const parts = [
      tool({ meta: { batchId: "s:0:0" } }),
      tool({ meta: { batchId: "s:0:0" } }),
      tool({ meta: { batchId: "s:0:0" } }),
    ] as Extract<TimelinePart, { kind: "tool" }>[];

    expect([...concurrentRuns(parts)]).toEqual([[0, 3]]);
    expect(largestConcurrentRun(parts)).toBe(3);
  });

  it("says nothing about calls the loop dispatched one at a time", () => {
    const parts = [tool(), tool(), tool()] as Extract<TimelinePart, { kind: "tool" }>[];

    expect(concurrentRuns(parts).size).toBe(0);
    expect(largestConcurrentRun(parts)).toBeUndefined();
  });

  // Adjacency is not evidence: a run gathers calls that merely followed one another, and only the
  // id the loop stamped says they actually went out together.
  it("does not read two neighbouring batches as one", () => {
    const parts = [
      tool({ meta: { batchId: "s:0:0" } }),
      tool({ meta: { batchId: "s:0:0" } }),
      tool({ meta: { batchId: "s:1:0" } }),
      tool({ meta: { batchId: "s:1:0" } }),
    ] as Extract<TimelinePart, { kind: "tool" }>[];

    expect([...concurrentRuns(parts)]).toEqual([
      [0, 2],
      [2, 2],
    ]);
  });

  it("keeps a batch together across a step that left no row", () => {
    const parts = [
      tool({ meta: { batchId: "s:0:0" } }),
      tool(),
      tool({ meta: { batchId: "s:0:0" } }),
    ] as Extract<TimelinePart, { kind: "tool" }>[];

    expect([...concurrentRuns(parts)]).toEqual([[0, 2]]);
  });

  it("stays silent when only one of a batch survived, rather than claiming a missing sibling", () => {
    const parts = [tool({ meta: { batchId: "s:0:0" } }), tool()] as Extract<
      TimelinePart,
      { kind: "tool" }
    >[];

    expect(concurrentRuns(parts).size).toBe(0);
  });

  it("reports the widest batch, which is what survives the run folding", () => {
    const parts = [
      tool({ meta: { batchId: "s:0:0" } }),
      tool({ meta: { batchId: "s:0:0" } }),
      tool({ meta: { batchId: "s:1:0" } }),
      tool({ meta: { batchId: "s:1:0" } }),
      tool({ meta: { batchId: "s:1:0" } }),
    ] as Extract<TimelinePart, { kind: "tool" }>[];

    expect(largestConcurrentRun(parts)).toBe(3);
  });
});

describe("derivePlanProgress", () => {
  const rounds = [
    { calls: [{ tool: "get_memory", label: "Recall what we agreed" }, { tool: "skill" }] },
    { calls: [{ tool: "routine_forge" }] },
  ];
  const statuses = (result: ReturnType<typeof derivePlanProgress>) =>
    result.flatMap((round) => round.calls.map((call) => call.status));

  it("carries the real call a step was matched to, so the step can report what ran", () => {
    // Without it a settled step can only flip a glyph; the reader never learns which call
    // satisfied the promise, or what it came back with.
    const matched = tool({ toolName: "get_memory", toolCallId: "call-7" });
    const result = derivePlanProgress(rounds, [matched], { streaming: true });

    expect(result[0]?.calls[0]?.part).toBe(matched);
    expect(result[0]?.calls[1]?.part).toBeUndefined();
    expect(result[1]?.calls[0]?.part).toBeUndefined();
  });

  it("ticks a planned call off only against a real call of that name", () => {
    const result = derivePlanProgress(
      rounds,
      [tool({ toolName: "get_memory" }), tool({ toolName: "skill", status: "running" })],
      { streaming: true }
    );

    expect(statuses(result)).toEqual(["done", "running", "pending"]);
    expect(result[0]?.calls[0]?.label).toBe("Recall what we agreed");
  });

  it("reports a planned call that failed as failed rather than done", () => {
    const result = derivePlanProgress(
      rounds,
      [tool({ toolName: "get_memory", outcome: "error" })],
      { streaming: true }
    );

    expect(statuses(result)).toEqual(["failed", "pending", "pending"]);
  });

  it("never lets two planned calls claim the same real one", () => {
    // Otherwise a plan that mentions a Tool twice would report both steps done off one call —
    // the trace claiming work the Turn did not do, which is the one thing it must never do.
    const twice = [{ calls: [{ tool: "skill" }] }, { calls: [{ tool: "skill" }] }];
    const result = derivePlanProgress(twice, [tool({ toolName: "skill" })], { streaming: true });

    expect(statuses(result)).toEqual(["done", "pending"]);
  });

  it("calls an unrun step skipped only once the Turn has stopped streaming", () => {
    const parts = [tool({ toolName: "get_memory" })];

    expect(statuses(derivePlanProgress(rounds, parts, { streaming: true }))).toEqual([
      "done",
      "pending",
      "pending",
    ]);
    expect(statuses(derivePlanProgress(rounds, parts))).toEqual(["done", "skipped", "skipped"]);
  });

  it("gives a plan part its own node, carrying the derived progress", () => {
    const nodes = groupTimelineParts(
      [{ kind: "plan", revision: 1, rounds }, tool({ toolName: "get_memory" })],
      { streaming: true }
    );
    const [plan] = nodes;

    expect(plan?.kind).toBe("plan");
    if (plan?.kind !== "plan") throw new Error("expected a plan node");
    expect(statuses(plan.rounds)).toEqual(["done", "pending", "pending"]);
  });

  it("absorbs every call it accounted for, so the Turn is not told twice", () => {
    // The step already discloses what that call ran and returned; a second row for it below the
    // plan is a duplicate to-do list with the same items ticked.
    const nodes = groupTimelineParts([
      { kind: "plan", revision: 1, rounds },
      tool({ toolName: "get_memory" }),
      tool({ toolName: "skill" }),
      tool({ toolName: "web_fetch" }),
    ]);

    expect(nodes.map((node) => node.kind)).toEqual(["plan"]);
  });

  it("puts a wave the plan never forecast in the Round that was current when it ran", () => {
    // The Agent departing from its own plan is the normal case, and the old split left the reader
    // with a list frozen at Round 1 beside a pile of unexplained calls — two accounts of one Turn.
    const result = derivePlanProgress(
      rounds,
      [
        tool({ toolName: "get_memory", meta: { batchId: "b1" } }),
        tool({ toolName: "skill", meta: { batchId: "b1" } }),
        tool({ toolName: "web_fetch", meta: { batchId: "b2" }, status: "running" }),
        tool({ toolName: "search_docs", meta: { batchId: "b2" }, status: "running" }),
      ],
      { streaming: true }
    );

    expect(result[1]?.calls.map((call) => call.tool)).toEqual([
      "routine_forge",
      "web_fetch",
      "search_docs",
    ]);
    // Labelled by the call, never by a promise: there was no promise.
    expect(result[1]?.calls.map((call) => call.unplanned)).toEqual([undefined, true, true]);
    // And it is the live Round now, which is the loading state a forecast alone could never show.
    expect(statuses(result)).toEqual(["done", "done", "pending", "running", "running"]);
    expect(result[1]?.atOnce).toBe(2);
  });

  it("keeps an unforecast wave in the Round it first appeared in", () => {
    // Observed live: four unplanned calls sat under Round 2, then the Agent's own Round 2 step
    // landed two waves later and shunted all four down to Round 3. A to-do list that reshuffles
    // itself under the reader is one they cannot follow.
    const three = [
      { calls: [{ tool: "get_memory" }] },
      { calls: [{ tool: "skill_create" }] },
      { calls: [{ tool: "agent_create" }] },
    ];
    const settled = [
      tool({ toolName: "get_memory", meta: { batchId: "b1" } }),
      tool({ toolName: "web_fetch", meta: { batchId: "b2" } }),
      tool({ toolName: "search_docs", meta: { batchId: "b2" } }),
    ];
    const homeOf = (parts: TimelinePart[]) =>
      derivePlanProgress(three, parts, { streaming: true }).findIndex((round) =>
        round.calls.some((call) => call.tool === "web_fetch")
      );

    expect(homeOf(settled)).toBe(1);
    expect(homeOf([...settled, tool({ toolName: "skill_create" })])).toBe(1);
  });

  it("does not let a stray late match drag unforecast work into a Round that has not started", () => {
    // Observed live: an exploratory `agent_get` was claimed by a step the Agent had planned for
    // Round 5, so four unforecast calls were filed under Round 4 while Round 2 had yet to run.
    const late = [
      { calls: [{ tool: "get_memory" }] },
      { calls: [{ tool: "skill_create" }] },
      { calls: [{ tool: "agent_get", label: "Verify the Agent" }] },
    ];
    const result = derivePlanProgress(
      late,
      [
        tool({ toolName: "get_memory", meta: { batchId: "b1" } }),
        tool({ toolName: "agent_get", meta: { batchId: "b2" } }),
        tool({ toolName: "web_fetch", meta: { batchId: "b2" } }),
      ],
      { streaming: true }
    );

    expect(result[1]?.calls.map((call) => call.tool)).toEqual(["skill_create", "web_fetch"]);
    expect(result[2]?.calls.map((call) => call.tool)).toEqual(["agent_get"]);
  });

  it("does not number a Round the Agent never claimed", () => {
    const result = derivePlanProgress(rounds, [
      tool({ toolName: "get_memory" }),
      tool({ toolName: "skill" }),
      tool({ toolName: "routine_forge" }),
      tool({ toolName: "web_fetch" }),
    ]);

    expect(result.map((round) => round.declared)).toEqual([true, true, false]);
    expect(result[2]?.calls.map((call) => call.tool)).toEqual(["web_fetch"]);
  });

  it("leaves a call awaiting approval outside the plan, where no fold can hide it", () => {
    // A settled plan folds to one line. An ask that folds with it is an ask the reader misses.
    const nodes = groupTimelineParts([
      { kind: "plan", revision: 1, rounds },
      tool({ toolName: "get_memory" }),
      tool({
        toolName: "routine_forge",
        status: "running",
        approval: { approvalId: "ap-1", status: "pending" },
      }),
    ]);

    expect(nodes.map((node) => node.kind)).toEqual(["plan", "tool-run"]);
    const [plan, asked] = nodes;
    if (plan?.kind !== "plan") throw new Error("expected a plan node");
    if (asked?.kind !== "tool-run") throw new Error("expected a tool-run");
    expect(asked.parts.map((part) => part.toolName)).toEqual(["routine_forge"]);
    // The step it would have satisfied stays unticked rather than claiming work not yet allowed.
    expect(statuses(plan.rounds)).toEqual(["done", "skipped", "skipped"]);
  });

  it("reports a Round's concurrency only from a batch its matched calls really shared", () => {
    const shared = groupTimelineParts([
      { kind: "plan", revision: 1, rounds },
      tool({ toolName: "get_memory", meta: { batchId: "b1" } }),
      tool({ toolName: "skill", meta: { batchId: "b1" } }),
    ]);
    const solo = groupTimelineParts([
      { kind: "plan", revision: 1, rounds },
      tool({ toolName: "get_memory" }),
      tool({ toolName: "skill" }),
    ]);

    const roundOf = (nodes: ReturnType<typeof groupTimelineParts>) => {
      const [plan] = nodes;
      if (plan?.kind !== "plan") throw new Error("expected a plan node");
      return plan.rounds[0];
    };

    expect(roundOf(shared)?.atOnce).toBe(2);
    // Two calls the loop chose to run one after the other are not a concurrent Round.
    expect(roundOf(solo)?.atOnce).toBeUndefined();
  });
});

describe("a plan_declare row", () => {
  it("is hidden when it succeeded, because the plan itself is the same fact", () => {
    const nodes = groupTimelineParts([tool({ toolName: "plan_declare" })]);
    expect(nodes).toEqual([]);
  });

  it("keeps its row when it failed, because a refused plan renders as nothing at all", () => {
    const nodes = groupTimelineParts([tool({ toolName: "plan_declare", outcome: "error" })]);
    expect(nodes).toHaveLength(1);
  });
});
