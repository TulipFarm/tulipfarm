import { describe, expect, it } from "vitest";
import type { TimelinePart } from "~/lib/chat/types";
import { groupTimelineParts, MIN_CLUSTER_SIZE } from "./timeline-groups";

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
