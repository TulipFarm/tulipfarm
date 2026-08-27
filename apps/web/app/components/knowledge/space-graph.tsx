import { useNavigate } from "@remix-run/react";
import { forceCenter, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { useEffect, useMemo, useState } from "react";
import type { SpaceGraph, SpacePageRef } from "~/lib/knowledge-api";
import { buildPageResolver, type PageResolver, pageHref } from "~/lib/page-href";

/* The d3-force simulation is ticked to stability, then frozen; there is no animation loop. */

const WIDTH = 720;
const HEIGHT = 480;
const R = 7;

type SimNode = {
  id: string;
  path: string | null;
  title: string;
  /** SPA navigation target; null = inert (no detail route, e.g. an unresolved cross-space stub). */
  href: string | null;
  /** A stub standing in for a page in ANOTHER space (rendered faded + labelled with the space). */
  crossSpace: boolean;
  x: number;
  y: number;
};
type SimEdge = { source: SimNode; target: SimNode; broken: boolean; crossSpace: boolean };

// Build the node + link sets for the simulation. Same-space nodes link to their page's stable
// UUID route via `pageHref(n.id, …)`; an edge whose target lives in another space (`targetSpaceName`
// set) gets a faded stub node so the link is drawn instead of silently dropped — clickable through when
// the resolver maps `(targetSpaceName, targetPath)` to a page id. Pure + deterministic (seeds every
// node at center) so it's unit-testable without running d3.
export function buildSimGraph(
  graph: SpaceGraph,
  resolver: PageResolver
): { nodes: SimNode[]; links: SimEdge[] } {
  const nodes: SimNode[] = graph.nodes.map((n) => ({
    id: n.id,
    path: n.path,
    title: n.title,
    href: n.path ? pageHref(n.id, n.path) : null,
    crossSpace: false,
    x: WIDTH / 2,
    y: HEIGHT / 2,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stubByKey = new Map<string, SimNode>();
  const links: SimEdge[] = [];
  for (const e of graph.edges) {
    const source = byId.get(e.sourceId);
    if (!source) continue;
    if (e.targetSpaceName) {
      const key = `x:${e.targetSpaceName}/${e.targetPath}`;
      let stub = stubByKey.get(key);
      if (!stub) {
        const lastSeg = e.targetPath.split("/").at(-1) || e.targetPath;
        const ref = resolver.bySpaceNamePath(e.targetSpaceName, e.targetPath);
        stub = {
          id: key,
          path: null,
          title: `${e.targetSpaceName}:${lastSeg}`,
          href: ref ? pageHref(ref.pageId, ref.path) : null,
          crossSpace: true,
          x: WIDTH / 2,
          y: HEIGHT / 2,
        };
        stubByKey.set(key, stub);
        nodes.push(stub);
      }
      links.push({ source, target: stub, broken: e.broken, crossSpace: true });
    } else if (e.targetId) {
      const target = byId.get(e.targetId);
      if (target) links.push({ source, target, broken: e.broken, crossSpace: false });
    }
  }
  return { nodes, links };
}

export function SpaceGraphView({ graph, pages }: { graph: SpaceGraph; pages: SpacePageRef[] }) {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<SimNode[]>([]);
  const [edges, setEdges] = useState<SimEdge[]>([]);
  const resolver = useMemo(() => buildPageResolver(pages), [pages]);

  useEffect(() => {
    const { nodes: simNodes, links: simLinks } = buildSimGraph(graph, resolver);

    const sim = forceSimulation(simNodes)
      .force("charge", forceManyBody().strength(-220))
      .force("center", forceCenter(WIDTH / 2, HEIGHT / 2))
      .force("x", forceX(WIDTH / 2).strength(0.04))
      .force("y", forceY(HEIGHT / 2).strength(0.04))
      .force(
        "link",
        forceLink(simLinks)
          .id((d) => (d as SimNode).id)
          .distance(90)
          .strength(0.5)
      )
      .stop();

    // Run the simulation headless to a stable layout, then clamp into the viewport and freeze.
    const iterations = Math.min(300, 100 + simNodes.length * 4);
    for (let i = 0; i < iterations; i++) sim.tick();
    for (const n of simNodes) {
      n.x = Math.max(R + 2, Math.min(WIDTH - R - 2, n.x));
      n.y = Math.max(R + 2, Math.min(HEIGHT - R - 2, n.y));
    }
    setNodes(simNodes);
    setEdges(simLinks);
  }, [graph, resolver]);

  if (graph.nodes.length === 0) {
    return <p className="text-muted-foreground">0 pages, nothing to graph</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {graph.truncated ? (
        <p className="text-xs text-muted-foreground">⚠ graph truncated, showing a partial view.</p>
      ) : null}
      <div className="overflow-hidden rounded-sm border border-border bg-card">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-auto w-full"
          role="img"
          aria-label="space cross-link graph"
        >
          <defs>
            <marker
              id="space-graph-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border)" />
            </marker>
          </defs>
          <g>
            {edges.map((e, i) => (
              <line
                key={`${e.source.id}-${e.target.id}-${i}`}
                x1={e.source.x}
                y1={e.source.y}
                x2={e.target.x}
                y2={e.target.y}
                stroke="var(--border)"
                strokeWidth={1}
                strokeDasharray={e.broken || e.crossSpace ? "4 3" : undefined}
                opacity={e.crossSpace ? 0.5 : 1}
                markerEnd="url(#space-graph-arrow)"
              />
            ))}
          </g>
          <g>
            {nodes.map((n) => {
              const fill = n.crossSpace ? "var(--muted-foreground)" : "var(--primary)";
              return <GraphNode key={n.id} node={n} fill={fill} navigate={navigate} />;
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}

// A single graph node. A page node wraps its visuals in an SVG <a> (a real link element — keeps
// the a11y linter happy and gives keyboard focus for free); the click is intercepted for SPA routing
// via the router's navigate. A node with no path (no detail route) renders an inert group.
function GraphNode({
  node,
  fill,
  navigate,
}: {
  node: SimNode;
  fill: string;
  navigate: (to: string) => void;
}) {
  const href = node.href;
  const opacity = node.crossSpace ? 0.55 : 1;
  const inner = (
    <>
      <circle r={R} fill={fill} stroke="var(--background)" strokeWidth={1.5} opacity={opacity}>
        <title>
          {node.title}
          {node.crossSpace ? " · cross-space" : ""}
        </title>
      </circle>
      <text
        x={R + 3}
        y={3}
        opacity={opacity}
        className="select-none fill-foreground text-[10px]"
        style={{ fontFamily: "ui-monospace, monospace" }}
      >
        {node.title}
      </text>
    </>
  );
  const transform = `translate(${node.x}, ${node.y})`;
  if (!href) {
    return (
      <g transform={transform} aria-label={node.title}>
        {inner}
      </g>
    );
  }
  // The SVG <a> sits inside a positioned <g> (React types `transform` only on the group, not the
  // anchor). The anchor is a real link; we intercept the click for client-side routing.
  return (
    <g transform={transform}>
      <a
        href={href}
        className="cursor-pointer"
        aria-label={node.title}
        onClick={(e) => {
          e.preventDefault();
          navigate(href);
        }}
      >
        {inner}
      </a>
    </g>
  );
}
