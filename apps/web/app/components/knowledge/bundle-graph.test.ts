import { describe, expect, it } from "vitest";
import { buildConceptResolver } from "~/lib/concept-href";
import type { BundleGraph, BundleGraphEdge, BundlePageRef } from "~/lib/knowledge-api";
import { buildSimGraph } from "./bundle-graph";

function graph(partial: Partial<BundleGraph>): BundleGraph {
  return { nodes: [], edges: [], truncated: false, ...partial };
}

// A same-bundle edge (no cross-space fields) unless overridden.
function edge(over: Partial<BundleGraphEdge> & Pick<BundleGraphEdge, "sourceId">): BundleGraphEdge {
  return {
    targetId: null,
    targetPath: "",
    broken: true,
    targetBundleName: null,
    targetBundleId: null,
    ...over,
  };
}

// Resolver that knows the cross-space target Sales/pricing → document "p" (Unknown/ghost stays unresolved).
const PAGES: BundlePageRef[] = [
  { documentId: "p", bundleId: "sales", bundleName: "Sales", path: "pricing", title: "Pricing" },
];
const resolver = buildConceptResolver(PAGES);

describe("buildSimGraph", () => {
  it("links two same-bundle nodes and routes them to their concept UUID pages", () => {
    const g = graph({
      nodes: [
        { id: "a", path: "runbook", title: "Runbook" },
        { id: "b", path: "oncall", title: "On-call" },
      ],
      edges: [edge({ sourceId: "b", targetId: "a", targetPath: "runbook", broken: false })],
    });
    const { nodes, links } = buildSimGraph(g, resolver);
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => !n.crossSpace)).toBe(true);
    expect(nodes.find((n) => n.id === "a")?.href).toBe("/knowledge/concepts/a/runbook");
    expect(links).toHaveLength(1);
    expect(links[0]?.crossSpace).toBe(false);
  });

  it("adds a faded clickable stub for a resolved cross-space edge", () => {
    const g = graph({
      nodes: [{ id: "a", path: "runbook", title: "Runbook" }],
      edges: [
        edge({
          sourceId: "a",
          targetId: "p",
          targetPath: "pricing",
          broken: false,
          targetBundleName: "Sales",
          targetBundleId: "sales",
        }),
      ],
    });
    const { nodes, links } = buildSimGraph(g, resolver);
    const stub = nodes.find((n) => n.crossSpace);
    expect(stub?.title).toBe("Sales:pricing");
    expect(stub?.href).toBe("/knowledge/concepts/p/pricing");
    expect(links[0]?.crossSpace).toBe(true);
  });

  it("renders an unresolved cross-space stub as inert (no href)", () => {
    const g = graph({
      nodes: [{ id: "a", path: "runbook", title: "Runbook" }],
      edges: [
        edge({
          sourceId: "a",
          targetPath: "ghost",
          targetBundleName: "Unknown",
          targetBundleId: null,
        }),
      ],
    });
    const { nodes } = buildSimGraph(g, resolver);
    expect(nodes.find((n) => n.crossSpace)?.href).toBeNull();
  });

  it("drops a broken same-space edge (no target node to attach)", () => {
    const g = graph({
      nodes: [{ id: "a", path: "runbook", title: "Runbook" }],
      edges: [edge({ sourceId: "a", targetPath: "missing" })],
    });
    const { nodes, links } = buildSimGraph(g, resolver);
    expect(nodes).toHaveLength(1);
    expect(links).toHaveLength(0);
  });

  it("dedupes multiple edges to the same cross-space target", () => {
    const g = graph({
      nodes: [
        { id: "a", path: "a", title: "A" },
        { id: "b", path: "b", title: "B" },
      ],
      edges: [
        edge({
          sourceId: "a",
          targetId: "p",
          targetPath: "pricing",
          broken: false,
          targetBundleName: "Sales",
          targetBundleId: "sales",
        }),
        edge({
          sourceId: "b",
          targetId: "p",
          targetPath: "pricing",
          broken: false,
          targetBundleName: "Sales",
          targetBundleId: "sales",
        }),
      ],
    });
    const { nodes, links } = buildSimGraph(g, resolver);
    expect(nodes.filter((n) => n.crossSpace)).toHaveLength(1);
    expect(links).toHaveLength(2);
  });
});
