import "@xyflow/react/dist/style.css";
import { Controls, type Edge, Handle, type Node, Position, ReactFlow } from "@xyflow/react";
import { useMemo, useState } from "react";
import {
  Bot,
  Braces,
  CircleDot,
  Clock,
  Flag,
  GitBranch,
  Hand,
  Maximize2,
  Minimize2,
  Radio,
  Split,
  TriangleAlert,
  Wrench,
  Zap,
} from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  layoutRoutineGraph,
  type RoutineEdgeKind,
  type RoutineGraph,
  type RoutineGraphNode,
  routineNodeDimensions,
} from "~/lib/routines/graph";
import type { RunNodeStatus, RunOverlay } from "~/lib/routines/run-overlay";

export type CanvasMode = "read" | "run" | "dry-run";

type Props = {
  graph: RoutineGraph;
  mode: CanvasMode;
  overlay?: RunOverlay;
  /** Says what a highlight on the graph means, next to the legend that explains the lines. */
  caption?: string;
};
type FlowNode = Node<{ label: React.ReactNode; source: RoutineGraphNode }>;

/**
 * The canvas node.
 *
 * A custom type rather than React Flow's `default`, because the vendor stylesheet paints
 * `.react-flow__node-default` a hard-coded white and is imported after the app's own CSS — a node
 * carrying theme classes still rendered near-white text on white in dark mode. Owning the type
 * means no vendor paint rule matches at all, so the node's classes govern as they do elsewhere.
 * The handles stay because edges need anchors; they are hidden, not removed.
 */
function CanvasNode({ data }: { data: { label: React.ReactNode } }) {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      {data.label}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}

const NODE_TYPES = { routine: CanvasNode };

const CANVAS_LABEL: Record<CanvasMode, string> = {
  read: "Routine canvas",
  run: "Run canvas",
  "dry-run": "Dry run canvas",
};

const statusText = (status?: RunNodeStatus) => status?.replace("_", " ") ?? "not executed";

/**
 * How each kind of path is drawn.
 *
 * Every edge already carries a visible text label, so colour and dash reinforce the distinction
 * rather than carry it — an error path and a happy path must not be told apart by hue alone. The
 * dash pattern is the redundant channel that survives both a monochrome display and a reader who
 * cannot separate red from grey.
 */
const EDGE_STYLE: Record<RoutineEdgeKind, { stroke: string; dash?: string; legend: string }> = {
  start: { stroke: "var(--primary)", legend: "A trigger starts the routine here" },
  transition: { stroke: "var(--border)", legend: "The next step" },
  condition: { stroke: "var(--status-info)", dash: "6 3", legend: "Taken when a test passes" },
  default: { stroke: "var(--status-info)", dash: "2 3", legend: "Taken when no test passed" },
  error: { stroke: "var(--status-danger)", dash: "4 4", legend: "Taken when the step fails" },
  end: { stroke: "var(--border)", dash: "1 4", legend: "The routine finishes" },
};

const STATE_ICON: Record<string, typeof Bot> = {
  agent: Bot,
  tool: Wrench,
  action: Wrench,
  script: Braces,
  compute: Braces,
  branch: Split,
  parallel: GitBranch,
  foreach: GitBranch,
  repeat_until: GitBranch,
  wait: Clock,
  approval: Hand,
  human_task: Hand,
  form: Hand,
  emit: Radio,
  child_routine: Zap,
};

function NodeIcon({ node, status }: { node: RoutineGraphNode; status?: RunNodeStatus }) {
  if (node.kind === "trigger") return <Zap aria-hidden="true" className="size-4" />;
  if (node.kind === "end") return <Flag aria-hidden="true" className="size-4" />;
  if (status?.includes("error") || status === "failed") {
    return <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />;
  }
  const Glyph = (node.stateType && STATE_ICON[node.stateType]) || CircleDot;
  return <Glyph aria-hidden="true" className="size-3.5 shrink-0" />;
}

/** Run status tints the node, never alone — the same word is printed inside it. */
function statusClass(status?: RunNodeStatus): string {
  if (status === "failed" || status?.includes("error")) return "border-status-danger/50";
  if (status === "completed") return "border-status-success/50";
  if (status === "running" || status === "retrying") return "border-status-info/50";
  if (status === "waiting_approval" || status === "sleeping") return "border-status-warning/50";
  return "border-border";
}

function nodeName(node: RoutineGraphNode, status?: RunNodeStatus, inferred?: boolean): string {
  const suffix = inferred ? ", Inferred from legacy Run" : "";
  if (node.kind === "trigger") {
    const index = node.id.split(":")[1];
    const type = node.triggerType ?? node.label.replace(/ Trigger$/, "");
    return `Trigger ${index}, ${type.charAt(0).toUpperCase()}${type.slice(1)}${suffix}`;
  }
  if (node.kind === "state") {
    /* Without a Run there is no status to report, and "not executed" would state a fact about a
       Run that was never asked for. */
    const state = status ? `, ${statusText(status)}` : "";
    return `State ${node.label}, ${node.stateType}${state}${suffix}`;
  }
  return `End${suffix}`;
}

function edgeName(edge: RoutineGraph["edges"][number], graph: RoutineGraph): string {
  const label = (id: string) => graph.nodes.find((node) => node.id === id)?.label ?? id;
  const index = edge.kind === "condition" ? Number(edge.id.split(":").at(-1)) + 1 : undefined;
  const kind = index ? `Condition ${index}` : edge.label;
  return `${kind} from ${label(edge.source)} to ${label(edge.target)}`;
}

const json = (value: unknown) => JSON.stringify(value).replaceAll(":", ": ");

/** Only the path kinds this graph actually contains, so the key never explains an absent line. */
function Legend({ kinds }: { kinds: readonly RoutineEdgeKind[] }) {
  if (kinds.length < 2) return null;
  return (
    <dl className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2 text-[11px]">
      {kinds.map((kind) => (
        <div key={kind} className="flex items-center gap-1.5">
          <dt className="sr-only">{kind.replaceAll("_", " ")}</dt>
          <svg aria-hidden="true" width="18" height="6" viewBox="0 0 18 6" className="shrink-0">
            <line
              x1="0"
              y1="3"
              x2="18"
              y2="3"
              stroke={EDGE_STYLE[kind].stroke}
              strokeWidth="2"
              strokeDasharray={EDGE_STYLE[kind].dash}
            />
          </svg>
          <dd className="text-muted-foreground">{EDGE_STYLE[kind].legend}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RoutineCanvas({ graph, mode, overlay, caption }: Props) {
  const [selected, setSelected] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const reduced =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const laidOut = useMemo(() => layoutRoutineGraph(graph), [graph]);
  const kinds = useMemo(
    () => [...new Set(graph.edges.map((edge) => edge.kind))].sort(),
    [graph.edges]
  );
  const nodes: FlowNode[] = laidOut.nodes.map((node) => {
    const run = overlay?.nodes[node.id];
    const { width, height } = routineNodeDimensions(node.kind);
    const actionSummary = node.actions
      // `function` already contains `name` in both the `tool` and `action` shapes; printing
      // both renders `send_slack_message: send_slack_message(...)`.
      ?.map((action) => `${action.function}(${action.arguments.join(", ")})`)
      .join(" · ");
    const tone =
      node.kind === "trigger"
        ? "border-primary/40 bg-primary/5"
        : node.kind === "end"
          ? "border-dashed border-border bg-muted/40"
          : `${statusClass(run?.status)} bg-card`;
    return {
      id: node.id,
      type: "routine",
      position: node.position,
      ariaRole: "presentation",
      focusable: false,
      selectable: true,
      draggable: false,
      measured: { width, height },
      className: `rounded-md border text-card-foreground shadow-none transition-colors hover:bg-accent active:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${run?.inferred ? "border-dashed" : ""} ${tone} ${selected === node.id ? "ring-2 ring-ring" : ""}`,
      style: { width, minHeight: height },
      data: {
        source: node,
        label: (
          <button
            type="button"
            aria-label={nodeName(node, run?.status, run?.inferred)}
            aria-describedby={actionSummary ? `${node.id}-actions` : undefined}
            aria-pressed={selected === node.id}
            title={run?.inferred ? "Inferred from legacy Run" : undefined}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setSelected(node.id);
            }}
            className="nodrag nopan flex min-h-11 w-full items-center gap-2 px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <NodeIcon node={node} status={run?.status} />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">{node.label}</span>
              <span className="block font-mono text-xs text-muted-foreground">
                {node.kind === "state"
                  ? `${node.stateType}${run?.status ? ` · ${statusText(run.status)}` : ""}`
                  : node.kind}
              </span>
              {actionSummary && (
                <span
                  id={`${node.id}-actions`}
                  className="mt-1 block truncate font-mono text-[0.625rem] text-muted-foreground"
                >
                  {actionSummary}
                </span>
              )}
            </span>
          </button>
        ),
      },
    };
  });
  const edges: Edge[] = laidOut.edges.map((edge) => {
    const run = overlay?.edges[edge.id];
    const animated = Boolean(run && !reduced);
    const style = EDGE_STYLE[edge.kind];
    return {
      ...edge,
      type: "smoothstep",
      ariaLabel: `${edgeName(edge, graph)}${run?.inferred ? ", Inferred from legacy Run" : ""}`,
      focusable: false,
      animated,
      label: edge.label,
      labelBgStyle: { fill: "var(--background)" },
      labelStyle: { fill: "var(--muted-foreground)", fontSize: 10 },
      style: {
        stroke: run ? "var(--primary)" : style.stroke,
        strokeWidth: run ? 2 : 1.5,
        strokeDasharray: run?.inferred ? "5 4" : style.dash,
      },
    };
  });
  const selectedNode = graph.nodes.find((node) => node.id === selected);
  const data = selectedNode ? overlay?.nodes[selectedNode.id] : undefined;
  return (
    <section
      aria-label={CANVAS_LABEL[mode]}
      /* The details column is reserved only once there is something to put in it: an empty 18rem
         gutter beside every graph reads as a panel that failed to load. */
      className={`grid gap-4 ${selected ? "lg:grid-cols-[minmax(0,1fr)_18rem]" : ""}`}
    >
      <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex items-center justify-between gap-2 border-b border-border">
          <Legend kinds={kinds} />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mr-2 shrink-0"
            aria-pressed={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? (
              <Minimize2 aria-hidden="true" className="size-3.5" />
            ) : (
              <Maximize2 aria-hidden="true" className="size-3.5" />
            )}
            {expanded ? "Shrink canvas" : "Expand canvas"}
          </Button>
        </div>
        {caption ? (
          <p className="border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {caption}
          </p>
        ) : null}
        <div
          className={`overflow-x-auto ${expanded ? "h-[min(46rem,calc(100dvh-10rem))]" : "h-[28rem]"}`}
        >
          <div className="h-full min-w-[44rem]">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              fitView
              nodesDraggable={false}
              nodesConnectable={false}
              edgesReconnectable={false}
              deleteKeyCode={null}
              panOnDrag
              minZoom={0.2}
              zoomOnDoubleClick={false}
              className="[&_.react-flow__handle]:hidden [&_.react-flow__attribution]:hidden"
              proOptions={{ hideAttribution: true }}
            >
              <Controls showInteractive={false} className="!shadow-none" />
            </ReactFlow>
            {edges.map((edge) => (
              <button
                key={edge.id}
                type="button"
                aria-label={edge.ariaLabel}
                title={
                  edge.ariaLabel?.includes("Inferred from legacy Run")
                    ? "Inferred from legacy Run"
                    : undefined
                }
                data-animated={edge.animated}
                onClick={() => setSelected(edge.id)}
                className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:min-h-11 focus:rounded-sm focus:border focus:border-border focus:bg-card focus:px-3 focus:outline-2 focus:outline-ring"
              >
                {edge.ariaLabel}
              </button>
            ))}
          </div>
        </div>
      </div>
      {selected && (
        <aside
          aria-label="State details"
          className="min-h-44 rounded-lg border border-border bg-card p-4 text-xs"
        >
          <h3 className="mb-3 font-mono text-xs text-muted-foreground">State details</h3>
          <p className="mb-3 font-medium">{selectedNode?.label ?? selected}</p>
          {selectedNode?.stateType && (
            <p className="mb-3 font-mono text-[0.625rem] text-muted-foreground">
              {selectedNode.stateType}
            </p>
          )}
          {/* The node truncates this to keep the graph legible; this is where it is readable. */}
          {selectedNode?.actions?.length ? (
            <ul className="mb-3 space-y-1">
              {selectedNode.actions.map((action) => (
                <li key={action.name} className="break-all font-mono text-[0.625rem]">
                  {action.function}({action.arguments.join(", ")})
                </li>
              ))}
            </ul>
          ) : null}
          {data?.input && (
            <p className="break-all">
              <span className="text-muted-foreground">Input </span>
              {json(data.input)}
            </p>
          )}
          {data?.output && (
            <p className="mt-2 break-all">
              <span className="text-muted-foreground">Output </span>
              {json(data.output)}
            </p>
          )}
          {data?.error && <p className="mt-2 break-all text-destructive">{json(data.error)}</p>}
          {data?.attempts !== undefined && <p className="mt-2">{data.attempts} attempts</p>}
          {(data?.startedAt || data?.completedAt) && (
            <p className="mt-2 font-mono text-[0.625rem] text-muted-foreground">
              {data.startedAt}, {data.completedAt}
            </p>
          )}
          {!data && mode !== "read" && (
            <p className="text-muted-foreground">This step did not execute.</p>
          )}
          {data?.inferred && (
            <p className="mt-3 border-t border-dashed border-border pt-3 text-muted-foreground">
              Inferred from legacy Run
            </p>
          )}
        </aside>
      )}
    </section>
  );
}
