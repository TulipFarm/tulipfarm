import { describe, expect, it } from "vitest";
import { type ClusterEdge, detectCommunities } from "./cluster";

function edge(source: string, target: string, weight = 1): ClusterEdge {
  return { source, target, weight };
}

/** Communities at the finest level, as sorted member lists, so assertions do not depend on ids. */
function level1(nodes: string[], edges: ClusterEdge[]): string[][] {
  return detectCommunities(nodes, edges)
    .filter((community) => community.level === 1)
    .map((community) => [...community.entityIds].sort())
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}

describe("detectCommunities", () => {
  it("returns nothing for an empty graph", () => {
    expect(detectCommunities([], [])).toEqual([]);
  });

  it("leaves an unconnected entity in a community of its own", () => {
    expect(level1(["a", "b"], [])).toEqual([["a"], ["b"]]);
  });

  it("separates two disconnected clusters", () => {
    const nodes = ["a", "b", "c", "x", "y", "z"];
    const edges = [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "a"),
      edge("x", "y"),
      edge("y", "z"),
      edge("z", "x"),
    ];
    expect(level1(nodes, edges)).toEqual([
      ["a", "b", "c"],
      ["x", "y", "z"],
    ]);
  });

  it("gathers a fully connected graph into one community and terminates", () => {
    const nodes = ["a", "b", "c", "d"];
    const edges = [
      edge("a", "b"),
      edge("a", "c"),
      edge("a", "d"),
      edge("b", "c"),
      edge("b", "d"),
      edge("c", "d"),
    ];
    expect(level1(nodes, edges)).toEqual([["a", "b", "c", "d"]]);
  });

  it("produces the same result whatever order the edges arrive in", () => {
    // A build must be reproducible, or its provenance and its cost report mean nothing.
    const nodes = ["a", "b", "c", "d", "e"];
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("d", "e")];
    const forward = detectCommunities(nodes, edges);
    const reversed = detectCommunities([...nodes].reverse(), [...edges].reverse());
    expect(JSON.stringify(reversed)).toEqual(JSON.stringify(forward));
  });

  it("names a community after its lowest member, so the id survives a relabelling", () => {
    const found = detectCommunities(["b", "a"], [edge("a", "b")]);
    expect(found[0]?.communityId).toContain("a");
  });

  it("follows the heavier edge when an entity could join either side", () => {
    const nodes = ["a", "b", "c"];
    const edges = [edge("a", "b", 1), edge("b", "c", 50)];
    const withB = level1(nodes, edges).find((members) => members.includes("b"));
    expect(withB).toContain("c");
  });

  it("ignores a self-loop rather than counting it as cohesion", () => {
    expect(level1(["a", "b"], [edge("a", "a"), edge("b", "b")])).toEqual([["a"], ["b"]]);
  });

  it("ignores an edge naming an entity that does not exist", () => {
    expect(level1(["a"], [edge("a", "ghost")])).toEqual([["a"]]);
  });

  it("records every entity exactly once at the finest level", () => {
    const nodes = ["a", "b", "c", "d"];
    const members = detectCommunities(nodes, [edge("a", "b"), edge("c", "d")])
      .filter((community) => community.level === 1)
      .flatMap((community) => community.entityIds);
    expect([...members].sort()).toEqual(nodes);
  });

  it("builds levels bottom-up, each one strictly coarser than the last", () => {
    const nodes = ["a", "b", "c", "d", "e", "f"];
    const edges = [
      edge("a", "b", 10),
      edge("c", "d", 10),
      edge("e", "f", 10),
      edge("b", "c", 1),
      edge("d", "e", 1),
    ];
    const all = detectCommunities(nodes, edges, { maxLevels: 3 });
    const levels = [...new Set(all.map((community) => community.level))].sort();
    for (let i = 1; i < levels.length; i++) {
      const finer = all.filter((c) => c.level === levels[i - 1]).length;
      const coarser = all.filter((c) => c.level === levels[i]).length;
      expect(coarser).toBeLessThan(finer);
    }
  });

  it("links every finer community to the coarser one that contains it", () => {
    const nodes = ["a", "b", "c", "d"];
    const edges = [edge("a", "b", 10), edge("c", "d", 10), edge("b", "c", 1)];
    const all = detectCommunities(nodes, edges, { maxLevels: 2 });
    const coarse = all.filter((community) => community.level === 2);
    if (coarse.length > 0) {
      for (const community of all.filter((c) => c.level === 1)) {
        expect(all.some((c) => c.communityId === community.parentCommunityId)).toBe(true);
      }
    }
  });

  it("stops at the level cap even when the graph would keep collapsing", () => {
    const nodes = ["a", "b", "c", "d"];
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];
    const all = detectCommunities(nodes, edges, { maxLevels: 1 });
    expect(all.every((community) => community.level === 1)).toBe(true);
  });
});
