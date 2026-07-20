import type { EdgeLabel, GraphLabel, NodeLabel } from "@dagrejs/dagre";
import { Graph, layout } from "@dagrejs/dagre";
import type { RoutineAction, RoutineDefinition, RoutineState } from "@tulipfarm/schema";

export type RoutineNodeKind = "trigger" | "state" | "end";
export type RoutineEdgeKind = "start" | "transition" | "end" | "condition" | "default" | "error";

export interface RoutineActionSummary {
  name: string;
  function: string;
  arguments: string[];
}

export interface RoutineGraphNode {
  id: string;
  kind: RoutineNodeKind;
  label: string;
  triggerType?: string;
  stateType?: RoutineState["type"];
  actions?: RoutineActionSummary[];
  position?: { x: number; y: number };
}

export interface RoutineGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: RoutineEdgeKind;
  label: string;
}

export interface RoutineGraph {
  nodes: RoutineGraphNode[];
  edges: RoutineGraphEdge[];
}

export interface LaidOutRoutineGraph extends RoutineGraph {
  nodes: Array<RoutineGraphNode & { position: { x: number; y: number } }>;
}

const stateId = (name: string) => `state:${encodeURIComponent(name)}`;

function triggerLabel(type: string): string {
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} Trigger`;
}

function summarizeActions(actions: RoutineAction[]): RoutineActionSummary[] {
  return actions.map((action) => ({
    name: action.name ?? action.functionRef.refName,
    function: action.functionRef.refName,
    arguments: Object.keys(action.functionRef.arguments ?? {}),
  }));
}

function stateActions(state: RoutineState): RoutineActionSummary[] {
  return state.type === "operation" || state.type === "foreach"
    ? summarizeActions(state.actions)
    : [];
}

function destination(transition: string | undefined, end: boolean | undefined): string | null {
  if (transition) return stateId(transition);
  return end ? "end" : null;
}

function stateEdges(state: RoutineState): RoutineGraphEdge[] {
  const edges: RoutineGraphEdge[] = [];
  const source = stateId(state.name);
  const add = (
    id: string,
    kind: RoutineEdgeKind,
    label: string,
    transition: string | undefined,
    end: boolean | undefined
  ) => {
    const target = destination(transition, end);
    if (target) edges.push({ id, source, target, kind, label });
  };

  if (state.type === "switch") {
    for (const [index, condition] of state.dataConditions.entries()) {
      add(
        `condition:${state.name}:${index}`,
        "condition",
        condition.condition,
        condition.transition,
        condition.end
      );
    }
    if (state.defaultCondition) {
      add(
        `default:${state.name}`,
        "default",
        "Default",
        state.defaultCondition.transition,
        state.defaultCondition.end
      );
    }
  } else {
    add(
      state.transition ? `transition:${state.name}` : `end:${state.name}`,
      state.transition ? "transition" : "end",
      state.transition ? "Next" : "End",
      state.transition,
      state.end
    );
  }

  for (const [index, error] of (state.onErrors ?? []).entries()) {
    add(`error:${state.name}:${index}`, "error", error.errorRef, error.transition, error.end);
  }
  return edges;
}

export function projectRoutineGraph(definition: RoutineDefinition): RoutineGraph {
  const nodes: RoutineGraphNode[] = definition["x-triggers"].map((trigger, index) => ({
    id: `trigger:${index}`,
    kind: "trigger",
    label: triggerLabel(trigger.type),
    triggerType: trigger.type,
  }));
  nodes.push(
    ...definition.states.map((state) => ({
      id: stateId(state.name),
      kind: "state" as const,
      label: state.name,
      stateType: state.type,
      actions: stateActions(state),
    })),
    { id: "end", kind: "end", label: "End" }
  );

  const edges: RoutineGraphEdge[] = definition["x-triggers"].map((_, index) => ({
    id: `start:${index}`,
    source: `trigger:${index}`,
    target: stateId(definition.start),
    kind: "start",
    label: "Starts",
  }));
  for (const state of definition.states) edges.push(...stateEdges(state));
  return { nodes, edges };
}

export function routineNodeDimensions(kind: RoutineNodeKind): { width: number; height: number } {
  if (kind === "state") return { width: 220, height: 96 };
  if (kind === "trigger") return { width: 180, height: 64 };
  return { width: 120, height: 56 };
}

export function layoutRoutineGraph(graph: RoutineGraph): LaidOutRoutineGraph {
  const dagre = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true }).setGraph({
    rankdir: "LR",
    nodesep: 48,
    ranksep: 96,
  });
  dagre.setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes) dagre.setNode(node.id, routineNodeDimensions(node.kind));
  for (const edge of graph.edges) dagre.setEdge(edge.source, edge.target, {}, edge.id);
  layout(dagre);

  return {
    nodes: graph.nodes.map((node) => {
      const placed = dagre.node(node.id);
      return {
        ...node,
        actions: node.actions?.map((action) => ({ ...action, arguments: [...action.arguments] })),
        position: {
          x: (placed.x ?? 0) - placed.width / 2,
          y: (placed.y ?? 0) - placed.height / 2,
        },
      };
    }),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
}
