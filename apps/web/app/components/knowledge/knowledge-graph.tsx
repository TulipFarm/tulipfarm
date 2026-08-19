import { useNavigate } from "@remix-run/react";
import { forceCenter, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { useMemo } from "react";
import type { KnowledgeGraph } from "~/lib/knowledge-api";
import { pageHref } from "~/lib/page-href";

const WIDTH = 900;
const HEIGHT = 560;
const R = 6;

/** Above this many nodes the labels stop being readable and start being a grey smear. */
export const LABEL_THRESHOLD = 60;

/**
 * One hue per Space, drawn from the data palette so the encoding survives both themes. Colour is
 * never the only carrier: the legend, the node's tooltip and the outline list all name the Space.
 */
const SPACE_COLORS = [
  "var(--data-1)",
  "var(--data-2)",
  "var(--data-3)",
  "var(--data-4)",
  "var(--data-5)",
  "var(--data-6)",
];

export interface GraphModelNode {
  id: string;
  title: string;
  href: string;
  spaceId: string;
  /** Null when the node's Space contributed no legend entry — the Page is still drawn. */
  spaceName: string | null;
  color: string;
  /** Counted from drawn links only. A degree that exceeds the visible arrows is a disclosure. */
  degree: number;
  x: number;
  y: number;
}

export interface GraphModelLink {
  source: GraphModelNode;
  target: GraphModelNode;
}

/**
 * Lay out and annotate the graph.
 *
 * Pure and deterministic: the simulation is seeded from each node's index rather than from random
 * jitter, ticked headless to a stable layout, then frozen. No animation loop, and the same input
 * always produces the same picture — which is what makes the layout testable at all.
 */
export function buildGraphModel(graph: KnowledgeGraph): {
  nodes: GraphModelNode[];
  links: GraphModelLink[];
  legend: Array<{ id: string; name: string; color: string }>;
  showLabels: boolean;
} {
  const colorOf = new Map<string, string>();
  graph.spaces.forEach((s, i) => {
    colorOf.set(s.id, SPACE_COLORS[i % SPACE_COLORS.length]);
  });
  const nameOf = new Map(graph.spaces.map((s) => [s.id, s.name]));

  const nodes: GraphModelNode[] = graph.nodes.map((n, i) => {
    const angle = (i / Math.max(1, graph.nodes.length)) * Math.PI * 2;
    return {
      id: n.id,
      title: n.title,
      href: pageHref(n.id, n.path),
      spaceId: n.spaceId,
      spaceName: nameOf.get(n.spaceId) ?? null,
      color: colorOf.get(n.spaceId) ?? "var(--muted-foreground)",
      degree: 0,
      x: WIDTH / 2 + Math.cos(angle) * 180,
      y: HEIGHT / 2 + Math.sin(angle) * 140,
    };
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links: GraphModelLink[] = [];
  for (const e of graph.edges) {
    const source = byId.get(e.sourceId);
    const target = byId.get(e.targetId);
    // An edge naming a node that is not drawn is dropped in silence. The server already refuses to
    // send one; this is the second lock, because a dangling arrow is the shape a withheld Page
    // leaves behind and it survives every other filter.
    if (!source || !target) continue;
    source.degree += 1;
    target.degree += 1;
    links.push({ source, target });
  }

  if (nodes.length > 0) {
    const sim = forceSimulation(nodes)
      .force("charge", forceManyBody().strength(-200))
      .force("center", forceCenter(WIDTH / 2, HEIGHT / 2))
      .force("x", forceX(WIDTH / 2).strength(0.05))
      .force("y", forceY(HEIGHT / 2).strength(0.05))
      .force(
        "link",
        forceLink(links)
          .id((d) => (d as GraphModelNode).id)
          .distance(80)
          .strength(0.4)
      )
      .stop();
    // Bounded work: a large corpus must not turn the tab into a space heater.
    const iterations = Math.min(240, 90 + nodes.length * 2);
    for (let i = 0; i < iterations; i++) sim.tick();
    for (const n of nodes) {
      n.x = Math.max(R + 2, Math.min(WIDTH - R - 2, n.x));
      n.y = Math.max(R + 2, Math.min(HEIGHT - R - 2, n.y));
    }
  }

  const usedSpaces = new Set(nodes.map((n) => n.spaceId));
  return {
    nodes,
    links,
    legend: graph.spaces
      .filter((s) => usedSpaces.has(s.id))
      .map((s) => ({
        id: s.id,
        name: s.name,
        color: colorOf.get(s.id) ?? "var(--muted-foreground)",
      })),
    showLabels: nodes.length <= LABEL_THRESHOLD,
  };
}

export function KnowledgeGraphView({ graph }: { graph: KnowledgeGraph }) {
  const navigate = useNavigate();
  const model = useMemo(() => buildGraphModel(graph), [graph]);

  if (model.nodes.length === 0) {
    return (
      <p data-testid="graph-empty" className="text-sm text-muted-foreground">
        No pages to graph yet. Write a page, link it to another, and the shape of your knowledge
        appears here.
      </p>
    );
  }

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <div className="flex flex-col gap-3">
      <p data-testid="graph-counts" className="text-xs text-muted-foreground">
        {plural(model.nodes.length, "page")} · {plural(model.links.length, "link")} ·{" "}
        {plural(model.legend.length, "space")}
      </p>
      {graph.truncated ? (
        <p data-testid="graph-truncated" className="text-xs text-warning">
          Showing part of the graph — the corpus is larger than this view draws.
        </p>
      ) : null}

      {model.legend.length > 0 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {model.legend.map((s) => (
            <li key={s.id} className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full" style={{ background: s.color }} />
              {s.name}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="overflow-hidden rounded-md border border-border bg-card">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-auto w-full"
          role="img"
          aria-label={`Link graph: ${plural(model.nodes.length, "page")}, ${plural(model.links.length, "link")}. The same information is listed below.`}
        >
          <g>
            {model.links.map((l) => (
              <line
                key={`${l.source.id}-${l.target.id}`}
                x1={l.source.x}
                y1={l.source.y}
                x2={l.target.x}
                y2={l.target.y}
                stroke="var(--border)"
                strokeWidth={1}
              />
            ))}
          </g>
          <g>
            {model.nodes.map((n) => (
              <g key={n.id} transform={`translate(${n.x}, ${n.y})`}>
                <a
                  href={n.href}
                  className="cursor-pointer"
                  aria-label={n.spaceName ? `${n.title} — ${n.spaceName}` : n.title}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(n.href);
                  }}
                >
                  <circle
                    r={R + Math.min(4, n.degree)}
                    fill={n.color}
                    stroke="var(--background)"
                    strokeWidth={1.5}
                  >
                    <title>
                      {n.title}
                      {n.spaceName ? ` · ${n.spaceName}` : ""}
                    </title>
                  </circle>
                  {model.showLabels ? (
                    <text
                      x={R + 5}
                      y={3}
                      className="select-none fill-foreground text-[10px]"
                      style={{ fontFamily: "ui-monospace, monospace" }}
                    >
                      {n.title}
                    </text>
                  ) : null}
                </a>
              </g>
            ))}
          </g>
        </svg>
      </div>

      {/*
        Not a fallback — the same graph, as text. A picture-only view is one a keyboard or screen
        reader user does not have, and the list is also the fastest way to reach a specific Page.
      */}
      <details className="rounded-md border border-border bg-card p-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          List every page and its links
        </summary>
        <ul data-testid="graph-outline" className="mt-3 flex flex-col gap-2 text-sm">
          {model.nodes.map((n) => (
            <li key={n.id}>
              <a href={n.href} className="font-medium text-foreground hover:text-primary">
                {n.title}
              </a>
              <span className="ml-2 text-xs text-muted-foreground">
                {n.spaceName ?? "unknown space"} · {plural(n.degree, "link")}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
