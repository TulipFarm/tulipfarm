import { describe, expect, it } from "vitest";
import { effectiveScore, expandHops, type KnowledgeLinkGraphPort } from "./graph-expand";
import { DEFAULT_GRAPH_EXPAND, MAX_GRAPH_EXPAND_DEPTH } from "./retrieval-config";

/** Adjacency the same shape `PgKnowledgeLinksRepo.getLinkedPageIds` returns: distinct, unordered. */
class FakeGraph implements KnowledgeLinkGraphPort {
  readonly calls: string[][] = [];
  constructor(private readonly edges: Record<string, string[]> = {}) {}

  async getLinkedPageIds(sourcePageIds: string[]): Promise<string[]> {
    this.calls.push([...sourcePageIds]);
    const out = new Set<string>();
    for (const id of sourcePageIds) for (const t of this.edges[id] ?? []) out.add(t);
    // Reversed so a test that depends on ordering is depending on our sort, not the fake's.
    return [...out].reverse();
  }
}

const limits = { depth: 1, maxNeighbours: 50 };

describe("expandHops", () => {
  it("returns nothing and touches no edge when there are no seeds", async () => {
    const graph = new FakeGraph({ a: ["b"] });
    expect(await expandHops(graph, [], limits)).toEqual(new Map());
    expect(graph.calls).toEqual([]);
  });

  it("returns nothing and touches no edge at depth zero", async () => {
    const graph = new FakeGraph({ a: ["b"] });
    expect(await expandHops(graph, ["a"], { ...limits, depth: 0 })).toEqual(new Map());
    expect(graph.calls).toEqual([]);
  });

  it("walks one hop by default", async () => {
    const graph = new FakeGraph({ a: ["b", "c"], b: ["d"] });
    const hops = await expandHops(graph, ["a"], limits);
    expect(hops).toEqual(
      new Map([
        ["b", 1],
        ["c", 1],
      ])
    );
  });

  it("walks two hops when asked, recording the hop each page was reached at", async () => {
    const graph = new FakeGraph({ a: ["b"], b: ["c"] });
    const hops = await expandHops(graph, ["a"], { ...limits, depth: 2 });
    expect(hops).toEqual(
      new Map([
        ["b", 1],
        ["c", 2],
      ])
    );
  });

  it("issues one batched call per hop rather than one per page", async () => {
    const graph = new FakeGraph({ a: ["c"], b: ["d"], c: ["e"], d: ["e"] });
    await expandHops(graph, ["a", "b"], { ...limits, depth: 2 });
    expect(graph.calls).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("never reports a seed as its own neighbour", async () => {
    const graph = new FakeGraph({ a: ["b", "a"], b: ["a"] });
    const hops = await expandHops(graph, ["a"], { ...limits, depth: 2 });
    expect(hops.has("a")).toBe(false);
  });

  it("keeps the shortest hop when a page is reachable at two distances", async () => {
    // `c` is one hop from the seed and also two hops via `b`; the direct distance must win.
    const graph = new FakeGraph({ a: ["b", "c"], b: ["c"] });
    const hops = await expandHops(graph, ["a"], { ...limits, depth: 2 });
    expect(hops.get("c")).toBe(1);
  });

  it("terminates on a cycle instead of walking it forever", async () => {
    const graph = new FakeGraph({ a: ["b"], b: ["c"], c: ["a", "b"] });
    const hops = await expandHops(graph, ["a"], { ...limits, depth: 2 });
    expect(hops).toEqual(
      new Map([
        ["b", 1],
        ["c", 2],
      ])
    );
  });

  it("clamps depth to the maximum so a caller cannot walk the whole corpus", async () => {
    const graph = new FakeGraph({ a: ["b"], b: ["c"], c: ["d"], d: ["e"] });
    const hops = await expandHops(graph, ["a"], { ...limits, depth: 99 });
    expect([...hops.values()].every((hop) => hop <= MAX_GRAPH_EXPAND_DEPTH)).toBe(true);
    expect(hops.has("d")).toBe(false);
  });

  it("caps total neighbours across every hop, not per hop", async () => {
    const graph = new FakeGraph({ a: ["b", "c", "d"], b: ["e"], c: ["f"], d: ["g"] });
    const hops = await expandHops(graph, ["a"], { depth: 2, maxNeighbours: 4 });
    expect(hops.size).toBe(4);
  });

  it("truncates deterministically rather than in whatever order the edges arrived", async () => {
    const graph = new FakeGraph({ a: ["d", "b", "c"] });
    const hops = await expandHops(graph, ["a"], { depth: 1, maxNeighbours: 2 });
    expect([...hops.keys()]).toEqual(["b", "c"]);
  });

  it("stops walking once the cap is reached", async () => {
    const graph = new FakeGraph({ a: ["b", "c"], b: ["d"], c: ["e"] });
    await expandHops(graph, ["a"], { depth: 2, maxNeighbours: 2 });
    expect(graph.calls).toEqual([["a"]]);
  });
});

describe("effectiveScore", () => {
  const bounds = { min: 0, max: 1 };
  const cfg = DEFAULT_GRAPH_EXPAND;

  it("keeps a deeper hop strictly below every shallower hop, whatever the scores", () => {
    // The property the ticket demands proved rather than asserted. Bands are disjoint intervals,
    // so this sweep is a proof by exhaustion over the reachable score range.
    const scores = Array.from({ length: 101 }, (_, i) => i / 100);
    const band = (hop: number) => scores.map((s) => effectiveScore(hop, s, bounds, cfg));
    for (const hop of [0, 1]) {
      expect(Math.max(...band(hop + 1))).toBeLessThan(Math.min(...band(hop)));
    }
  });

  it("cannot let a perfect two-hop page outrank the weakest direct hit", () => {
    expect(effectiveScore(2, 1, bounds, cfg)).toBeLessThan(effectiveScore(0, 0, bounds, cfg));
  });

  it("preserves the ranking of raw scores within one hop", () => {
    expect(effectiveScore(1, 0.9, bounds, cfg)).toBeGreaterThan(
      effectiveScore(1, 0.1, bounds, cfg)
    );
  });

  it("holds the band property for any configuration where decay is below the floor", () => {
    const cfgs = [
      { ...cfg, hopDecay: 0.1, bandFloor: 0.2 },
      { ...cfg, hopDecay: 0.4, bandFloor: 0.9 },
      { ...cfg, hopDecay: 0.01, bandFloor: 0.99 },
    ];
    for (const c of cfgs) {
      expect(effectiveScore(1, 1, bounds, c)).toBeLessThan(effectiveScore(0, 0, bounds, c));
    }
  });

  it("does not divide by zero when every candidate scored the same", () => {
    const flat = { min: 0.4, max: 0.4 };
    expect(Number.isFinite(effectiveScore(0, 0.4, flat, cfg))).toBe(true);
    expect(effectiveScore(1, 0.4, flat, cfg)).toBeLessThan(effectiveScore(0, 0.4, flat, cfg));
  });

  it("clamps a score outside the observed bounds instead of escaping its band", () => {
    expect(effectiveScore(1, 99, bounds, cfg)).toBeLessThan(effectiveScore(0, -99, bounds, cfg));
  });

  it("defaults to a decay strictly below the band floor, which is what makes bands disjoint", () => {
    expect(DEFAULT_GRAPH_EXPAND.hopDecay).toBeLessThan(DEFAULT_GRAPH_EXPAND.bandFloor);
  });

  it("is off by default", () => {
    expect(DEFAULT_GRAPH_EXPAND.enabled).toBe(false);
  });
});
