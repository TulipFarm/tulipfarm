import type { RunEvent } from "../routines";
import type { RoutineGraph, RoutineGraphEdge } from "./graph";

export type RunNodeStatus =
  | "running"
  | "completed"
  | "retrying"
  | "sleeping"
  | "waiting_approval"
  | "handled_error"
  | "failed"
  | "cancelled";

export interface RunNodeOverlay extends Partial<Record<"exact" | "inferred", boolean>> {
  status: RunNodeStatus;
  label?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: Record<string, unknown>;
  attempts?: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface RunOverlay {
  lastSeq: number;
  nodes: Record<string, RunNodeOverlay>;
  edges: Record<string, { status: "taken"; exact?: boolean; inferred?: boolean; label?: string }>;
}
const INFERRED = { status: "taken", inferred: true, label: "Inferred from legacy Run" } as const;
const stateId = (state = "") => `state:${encodeURIComponent(state)}`;
const rec = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
function routeId(source: string, route: Record<string, unknown>): string | undefined {
  const index = num(route.index);
  if (route.kind === "transition") return `transition:${source}`;
  if (route.kind === "end") return `end:${source}`;
  if (route.kind === "default") return `default:${source}`;
  if (route.kind === "condition" && Number.isInteger(index)) return `condition:${source}:${index}`;
  if (route.kind === "error" && Number.isInteger(index)) return `error:${source}:${index}`;
}

function transitionTarget(payload: Record<string, unknown>): string | undefined {
  const target = text(payload.target);
  if (target) return stateId(target);
  return payload.end === true ? "end" : undefined;
}

function inferEdges(overlay: RunOverlay, edges: RoutineGraphEdge[]): void {
  for (const edge of edges) overlay.edges[edge.id] = INFERRED;
}

function setState(
  overlay: RunOverlay,
  state: string,
  status: RunNodeStatus,
  data: Partial<RunNodeOverlay> = {}
): void {
  const id = stateId(state);
  overlay.nodes[id] = { ...overlay.nodes[id], status, exact: true, ...data };
}

function restoreSleep(overlay: RunOverlay, state?: string): void {
  if (state && overlay.nodes[stateId(state)]?.status === "sleeping")
    setState(overlay, state, "completed");
}

export function reduceRunOverlay(graph: RoutineGraph, events: readonly RunEvent[]): RunOverlay {
  const overlay: RunOverlay = { lastSeq: 0, nodes: {}, edges: {} };
  const unique = new Map<number, RunEvent>();
  for (const event of events) {
    if (Number.isInteger(event.seq) && event.seq >= 0 && !unique.has(event.seq)) {
      unique.set(event.seq, event);
    }
  }

  let previousEntry: string | undefined;
  let explicitSinceEntry = false;
  let completed: string | undefined;
  for (const event of [...unique.values()].sort((a, b) => a.seq - b.seq)) {
    overlay.lastSeq = Math.max(overlay.lastSeq, event.seq);
    const payload = rec(event.payload);
    if (!payload) continue;
    const state = text(payload.state);
    const rawAt = text(event.createdAt);
    const at = rawAt && Number.isFinite(Date.parse(rawAt)) ? rawAt : undefined;

    if (event.type === "run.started") {
      const index = num(payload.triggerIndex);
      const id = Number.isInteger(index) ? `trigger:${index}` : undefined;
      if (id && graph.nodes.some((node) => node.id === id)) {
        overlay.nodes[id] = { status: "completed", exact: true };
        if (graph.edges.some((edge) => edge.id === `start:${index}`)) {
          overlay.edges[`start:${index}`] = { status: "taken", exact: true };
        }
      } else if (payload.triggerIndex === undefined) {
        const trigger = payload.trigger;
        const type = text(trigger) ?? text(rec(trigger)?.type);
        if (!type) continue;
        for (const node of graph.nodes.filter(
          (candidate) =>
            candidate.kind === "trigger" &&
            (candidate.triggerType ?? candidate.label.replace(/ Trigger$/, "").toLowerCase()) ===
              type
        )) {
          overlay.nodes[node.id] = {
            status: "completed",
            inferred: true,
            label: INFERRED.label,
          };
          const edge = graph.edges.find((candidate) => candidate.source === node.id);
          if (edge) overlay.edges[edge.id] = INFERRED;
        }
      }
    } else if (event.type === "state.entered" && state) {
      restoreSleep(overlay, previousEntry === state ? undefined : previousEntry);
      if (previousEntry && !explicitSinceEntry) {
        inferEdges(
          overlay,
          graph.edges.filter(
            (edge) => edge.source === stateId(previousEntry) && edge.target === stateId(state)
          )
        );
      }
      setState(overlay, state, "running", {
        input: rec(payload.input),
        attempts: num(payload.attempt),
        startedAt: at,
      });
      previousEntry = state;
      explicitSinceEntry = false;
      completed = undefined;
    } else if (event.type === "state.completed" && state) {
      const prior = overlay.nodes[stateId(state)];
      const duration = prior?.startedAt && at ? Date.parse(at) - Date.parse(prior.startedAt) : -1;
      setState(overlay, state, "completed", {
        output: rec(payload.output),
        completedAt: at,
        ...(duration >= 0 ? { durationMs: duration } : {}),
      });
      completed = state;
    } else if (event.type === "state.transitioned") {
      const source = text(payload.source);
      if (source && previousEntry === source) explicitSinceEntry = true;
      const route = rec(payload.route);
      const target = transitionTarget(payload);
      if (!source || !route || !target) continue;
      const edge = graph.edges.find((candidate) => candidate.id === routeId(source, route));
      if (!edge || edge.target !== target) continue;
      overlay.edges[edge.id] = { status: "taken", exact: true };
      if (target === "end") overlay.nodes.end = { status: "completed", exact: true };
      if (route.kind === "error") {
        setState(overlay, source, "handled_error", { error: rec(route.error) });
      }
    } else {
      const current = state ?? previousEntry;
      const cancelled =
        event.type === "run.cancelled" ||
        (event.type === "finish" && payload.reason === "cancelled");
      if (event.type === "finish" && payload.reason === "completed") {
        restoreSleep(overlay, completed);
      }
      if (event.type === "state.retrying" && current) {
        setState(overlay, current, "retrying", {
          attempts: num(payload.attempt),
          error: rec(payload.error),
        });
      } else if (event.type === "run.sleeping" && current) {
        setState(overlay, current, "sleeping");
      } else if (event.type === "run.waiting_approval" && current) {
        setState(overlay, current, "waiting_approval", {
          input: rec(payload.pendingInput),
        });
      } else if (event.type === "error" && current) {
        setState(overlay, current, "failed", { error: rec(payload.error) });
      } else if (cancelled && current) {
        setState(overlay, current, "cancelled");
      } else if (
        event.type === "finish" &&
        payload.reason === "completed" &&
        completed &&
        !explicitSinceEntry &&
        !overlay.nodes.end?.exact
      ) {
        const candidates = graph.edges.filter(
          (edge) => edge.source === stateId(completed) && edge.target === "end"
        );
        inferEdges(overlay, candidates);
        if (candidates.length) {
          overlay.nodes.end = { status: "completed", inferred: true, label: INFERRED.label };
        }
      }
    }
  }
  return overlay;
}
