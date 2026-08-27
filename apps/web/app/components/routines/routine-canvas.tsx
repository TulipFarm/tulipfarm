import "@xyflow/react/dist/style.css";
import { type Edge, type Node, ReactFlow } from "@xyflow/react";
import { Circle, Flag, TriangleAlert, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import {
  layoutRoutineGraph,
  type RoutineGraph,
  type RoutineGraphNode,
  routineNodeDimensions,
} from "~/lib/routines/graph";
import type { RunNodeStatus, RunOverlay } from "~/lib/routines/run-overlay";

type Props = { graph: RoutineGraph; mode: "read" | "run"; overlay?: RunOverlay };
type FlowNode = Node<{ label: React.ReactNode; source: RoutineGraphNode }>;
const statusText = (status?: RunNodeStatus) => status?.replace("_", " ") ?? "not executed";
const Icon = ({ status }: { status?: RunNodeStatus }) => {
  const C = status?.includes("error") || status === "failed" ? TriangleAlert : Circle;
  return <C aria-hidden="true" className="size-3.5 shrink-0" />;
};

function NodeIcon({ node, status }: { node: RoutineGraphNode; status?: RunNodeStatus }) {
  if (node.kind === "trigger") return <Zap aria-hidden="true" className="size-4" />;
  if (node.kind === "end") return <Flag aria-hidden="true" className="size-4" />;
  return <Icon status={status} />;
}

function nodeName(node: RoutineGraphNode, status?: RunNodeStatus, inferred?: boolean): string {
  const suffix = inferred ? ", Inferred from legacy Run" : "";
  if (node.kind === "trigger") {
    const index = node.id.split(":")[1];
    const type = node.triggerType ?? node.label.replace(/ Trigger$/, "");
    return `Trigger ${index}, ${type.charAt(0).toUpperCase()}${type.slice(1)}${suffix}`;
  }
  if (node.kind === "state")
    return `State ${node.label}, ${node.stateType}, ${statusText(status)}${suffix}`;
  return `End${suffix}`;
}

function edgeName(edge: RoutineGraph["edges"][number], graph: RoutineGraph): string {
  const label = (id: string) => graph.nodes.find((node) => node.id === id)?.label ?? id;
  const index = edge.kind === "condition" ? Number(edge.id.split(":").at(-1)) + 1 : undefined;
  const kind = index ? `Condition ${index}` : edge.label;
  return `${kind} from ${label(edge.source)} to ${label(edge.target)}`;
}

const json = (value: unknown) => JSON.stringify(value).replaceAll(":", ": ");

export function RoutineCanvas({ graph, mode, overlay }: Props) {
  const [selected, setSelected] = useState<string>();
  const reduced =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const laidOut = useMemo(() => layoutRoutineGraph(graph), [graph]);
  const nodes: FlowNode[] = laidOut.nodes.map((node) => {
    const run = overlay?.nodes[node.id];
    const { width, height } = routineNodeDimensions(node.kind);
    const actionSummary = node.actions
      ?.map((action) => `${action.name}: ${action.function}(${action.arguments.join(", ")})`)
      .join(" · ");
    return {
      id: node.id,
      position: node.position,
      ariaRole: "presentation",
      focusable: false,
      selectable: true,
      draggable: false,
      measured: { width, height },
      className: `rounded-sm border bg-card text-card-foreground shadow-none hover:bg-accent active:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${run?.inferred ? "border-dashed" : "border-border"}`,
      style: { width, minHeight: height },
      data: {
        source: node,
        label: (
          <button
            type="button"
            aria-label={nodeName(node, run?.status, run?.inferred)}
            aria-describedby={actionSummary ? `${node.id}-actions` : undefined}
            title={run?.inferred ? "Inferred from legacy Run" : undefined}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setSelected(node.id);
            }}
            className="nodrag nopan flex min-h-11 w-full items-center gap-2 px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <NodeIcon node={node} status={run?.status} />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">{node.label}</span>
              <span className="block font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted-foreground">
                {node.kind === "state" ? statusText(run?.status) : node.kind}
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
    return {
      ...edge,
      type: "smoothstep",
      ariaLabel: `${edgeName(edge, graph)}${run?.inferred ? ", Inferred from legacy Run" : ""}`,
      focusable: false,
      animated,
      label: edge.label,
      className: run?.inferred ? "[&_path]:stroke-dasharray-[5_4]" : undefined,
      style: { stroke: run ? "var(--primary)" : "var(--border)", strokeWidth: run ? 2 : 1 },
    };
  });
  const selectedNode = graph.nodes.find((node) => node.id === selected);
  const data = selectedNode ? overlay?.nodes[selectedNode.id] : undefined;
  return (
    <section
      aria-label={mode === "run" ? "Run canvas" : "Routine canvas"}
      className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]"
    >
      <div className="h-[26rem] min-w-0 overflow-x-auto rounded-sm border border-border bg-background">
        <div className="h-full min-w-[44rem]">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            edgesReconnectable={false}
            deleteKeyCode={null}
            panOnDrag
            zoomOnDoubleClick={false}
            className="[&_.react-flow__handle]:hidden [&_.react-flow__attribution]:hidden"
            proOptions={{ hideAttribution: true }}
          />
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
      {selected && (
        <aside
          aria-label="State details"
          className="min-h-44 rounded-sm border border-border bg-card p-4 text-xs"
        >
          <h3 className="mb-3 font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground">
            State details
          </h3>
          <p className="mb-3 font-medium">{selectedNode?.label ?? selected}</p>
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
