/**
 * Ticket 29 — the Business-wide link graph, as a picture and as a list.
 *
 * Two properties are load-bearing and neither is visual. First, the picture must never claim more
 * than it draws: a degree count that exceeds the visible arrows tells a restricted reader exactly
 * how many neighbours were withheld. Second, everything the picture says must also be reachable
 * without seeing it — a graph that only exists as an SVG is a graph some people simply do not have.
 */
import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "~/lib/knowledge-api";
import { buildGraphModel, LABEL_THRESHOLD } from "./knowledge-graph";

function graph(partial: Partial<KnowledgeGraph>): KnowledgeGraph {
  return { nodes: [], edges: [], spaces: [], truncated: false, ...partial };
}

const two = graph({
  nodes: [
    { id: "a", path: "runbook", title: "Runbook", spaceId: "eng" },
    { id: "b", path: "oncall", title: "On-call", spaceId: "ops" },
  ],
  edges: [{ sourceId: "a", targetId: "b" }],
  spaces: [
    { id: "eng", name: "Engineering" },
    { id: "ops", name: "Ops" },
  ],
});

describe("buildGraphModel", () => {
  it("routes every node at its Page, so the graph is navigation and not only a picture", () => {
    const { nodes } = buildGraphModel(two);
    expect(nodes.find((n) => n.id === "a")?.href).toBe("/knowledge/pages/a/runbook");
  });

  it("names each node's Space, so a node's origin is legible without opening it", () => {
    const { nodes } = buildGraphModel(two);
    expect(nodes.find((n) => n.id === "b")?.spaceName).toBe("Ops");
  });

  it("gives each Space a distinct colour and reports the legend it used", () => {
    const { legend } = buildGraphModel(two);
    expect(legend.map((l) => l.name)).toEqual(["Engineering", "Ops"]);
    expect(new Set(legend.map((l) => l.color)).size).toBe(2);
  });

  it("counts degree only from edges it actually draws", () => {
    const model = buildGraphModel(
      graph({
        ...two,
        // An edge naming a node that is not in the node list — the shape a withheld Page leaves.
        edges: [
          { sourceId: "a", targetId: "b" },
          { sourceId: "a", targetId: "withheld" },
        ],
      })
    );
    expect(model.links).toHaveLength(1);
    expect(model.nodes.find((n) => n.id === "a")?.degree).toBe(1);
  });

  it("drops an edge whose source is missing too, not only its target", () => {
    const model = buildGraphModel(
      graph({ ...two, edges: [{ sourceId: "withheld", targetId: "b" }] })
    );
    expect(model.links).toEqual([]);
    expect(model.nodes.find((n) => n.id === "b")?.degree).toBe(0);
  });

  it("labels every node in a small graph", () => {
    expect(buildGraphModel(two).showLabels).toBe(true);
  });

  it("stops labelling once the graph would become an unreadable mass", () => {
    const many = graph({
      nodes: Array.from({ length: LABEL_THRESHOLD + 1 }, (_, i) => ({
        id: `n${i}`,
        path: `p${i}`,
        title: `T${i}`,
        spaceId: "eng",
      })),
      spaces: [{ id: "eng", name: "Engineering" }],
    });
    expect(buildGraphModel(many).showLabels).toBe(false);
  });

  it("keeps a node whose Space is missing from the legend rather than dropping the Page", () => {
    const orphan = graph({
      nodes: [{ id: "a", path: "runbook", title: "Runbook", spaceId: "gone" }],
      spaces: [],
    });
    const { nodes, legend } = buildGraphModel(orphan);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].spaceName).toBe(null);
    expect(legend).toEqual([]);
  });

  it("is deterministic: the same graph produces the same layout twice", () => {
    const a = buildGraphModel(two);
    const b = buildGraphModel(two);
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
  });

  it("lays out an empty graph without throwing", () => {
    const model = buildGraphModel(graph({}));
    expect(model.nodes).toEqual([]);
    expect(model.links).toEqual([]);
  });
});
