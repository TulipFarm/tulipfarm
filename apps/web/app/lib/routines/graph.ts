import type { EdgeLabel, GraphLabel, NodeLabel } from "@dagrejs/dagre";
import { Graph, layout } from "@dagrejs/dagre";
import type { routine } from "@tulipfarm/schema";

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
  /** The canonical State `type`, rendered as text; the canvas does not branch on its value. */
  stateType?: string;
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

/** What a graph needs from a Trigger; the Routines catalog answers exactly this. */
export interface RoutineGraphTrigger {
  slug: string;
  type: string;
}

type RoutineState = routine.RoutineState;

const stateId = (name: string) => `state:${encodeURIComponent(name)}`;

function triggerLabel(type: string): string {
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} Trigger`;
}

/**
 * What the State does, in the shape the canvas already renders.
 *
 * A canonical State is one typed step rather than a list of actions, so each yields at most one
 * summary — the Agent it runs, or the Tool action it calls.
 */
function stateActions(state: RoutineState): RoutineActionSummary[] {
  if (state.type === "agent") {
    return [{ name: state.agentRef.name, function: state.agentRef.name, arguments: [] }];
  }
  if (state.type === "tool") {
    return [
      {
        name: state.action,
        function: `${state.toolRef.name}.${state.action}`,
        arguments: state.destination ? [state.destination] : [],
      },
    ];
  }
  if (state.type === "child_routine") {
    return [{ name: state.routineRef.name, function: state.routineRef.name, arguments: [] }];
  }
  if (state.type === "emit") {
    return [{ name: state.event.type, function: state.event.type, arguments: [] }];
  }
  // An `action` names the runtime Tool it calls; the arguments it passes identify the call.
  if (state.type === "action") {
    const args = Object.keys((state.input ?? {}) as Record<string, unknown>).sort();
    return [{ name: state.action, function: state.action, arguments: args }];
  }
  // A `script` has no ref either, so its entry point is the most honest label available.
  if (state.type === "script") {
    return [{ name: "script", function: state.entry ?? "run", arguments: [] }];
  }
  // A `compute` State has no ref to name, so the fields it assigns are what identifies it.
  if (state.type === "compute") {
    const assigned = Object.keys((state.input ?? {}) as Record<string, unknown>).sort();
    return [{ name: "compute", function: "compute", arguments: assigned }];
  }
  return [];
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

  if (state.type === "branch") {
    for (const [index, condition] of state.conditions.entries()) {
      add(
        `condition:${state.name}:${index}`,
        "condition",
        condition.condition,
        condition.transition,
        condition.end
      );
    }
    if (state.default) {
      add(
        `default:${state.name}`,
        "default",
        "Default",
        state.default.transition,
        state.default.end
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

  // A body or branch is a State the graph must still reach: it is entered by containment, not by
  // a `transition`, so without these edges those States render as unreachable islands.
  if (state.type === "parallel") {
    for (const [index, branch] of state.branches.entries()) {
      add(`branch:${state.name}:${index}`, "transition", "Branch", branch, undefined);
    }
  }
  if ((state.type === "foreach" || state.type === "repeat_until") && state.body) {
    add(`body:${state.name}`, "transition", "Body", state.body, undefined);
  }

  for (const [index, error] of (state.onError ?? []).entries()) {
    add(`error:${state.name}:${index}`, "error", error.errorRef, error.transition, error.end);
  }
  return edges;
}

/**
 * Projects one published Routine into the canvas graph.
 *
 * Triggers come from the catalog rather than the document: a canonical Routine does not carry its
 * own Triggers, they are separate definitions that name it.
 */
export function projectRoutineGraph(
  definition: routine.RoutineDefinition,
  triggers: readonly RoutineGraphTrigger[] = []
): RoutineGraph {
  const nodes: RoutineGraphNode[] = triggers.map((trigger) => ({
    id: `trigger:${trigger.slug}`,
    kind: "trigger",
    label: triggerLabel(trigger.type),
    triggerType: trigger.type,
  }));
  nodes.push(
    ...definition.spec.states.map((state) => ({
      id: stateId(state.name),
      kind: "state" as const,
      label: state.name,
      stateType: state.type,
      actions: stateActions(state),
    })),
    { id: "end", kind: "end", label: "End" }
  );

  const edges: RoutineGraphEdge[] = triggers.map((trigger) => ({
    id: `start:${trigger.slug}`,
    source: `trigger:${trigger.slug}`,
    target: stateId(definition.spec.start),
    kind: "start",
    label: "Starts",
  }));
  for (const state of definition.spec.states) edges.push(...stateEdges(state));
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
