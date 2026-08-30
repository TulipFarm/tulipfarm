import { apiWrite } from "../api";
import type { RoutineGraph } from "./graph";
import type { RunOverlay } from "./run-overlay";

/**
 * Simulating a published Routine without letting it touch anything.
 *
 * The runtime already refuses a simulated Run the live ports — every previewed effect carries
 * `dispatched: false` and `secretLeased: false` from the kernel itself, not from a flag this
 * module sets. So a dry run is not "a run with side effects turned off", which would be a promise
 * the browser is in no position to keep; it is a different execution mode that has no ports to
 * turn off. That distinction is why the button beside "Run now" is safe to offer at all.
 */

/**
 * One step the simulation executed.
 *
 * The dry-run route requires only `stateName`; everything else is whatever the kernel happens to
 * emit. Keeping the rest optional means the first field the kernel renames dims one row rather
 * than breaking the page.
 */
export interface DryRunStep {
  stateName: string;
  type?: string;
  atMs?: number;
  source?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  next?: { kind: "transition"; target: string } | { kind: "end" };
}

/** One effect the Routine *would* have caused, with proof that it did not. */
export interface DryRunEffect {
  stateName: string;
  toolRef: string;
  action: string;
  credentialRef?: string | null;
  input?: Record<string, unknown>;
  idempotencyKey?: string;
  dispatched: false;
  secretLeased: false;
}

/** What the dry-run route returns. */
export type DryRunResponse = Omit<DryRunResult, "durationMs">;

export interface DryRunResult {
  risk: "medium" | "high";
  steps: DryRunStep[];
  effects: DryRunEffect[];
  /**
   * States whose output the rehearsal invented because no real call was made. A branch reading
   * one of these may take a path a real Run would not, so the effects are trustworthy and the
   * path through them is only indicative.
   */
  stubbedStates: string[];
  /** Equal fixtures produce equal hashes, so two dry runs are comparable. */
  resultHash: string;
  durationMs: number;
}

const stateId = (name: string) => `state:${encodeURIComponent(name)}`;

/**
 * Paints a simulation onto the canvas the reader is already looking at.
 *
 * A branch's `next` names only the target it chose, never which condition matched, so the taken
 * edge is found by its endpoints. That is exact whenever a pair of states is joined once, and when
 * it is not, the first match is still one of the edges the simulation could have taken — which is
 * why nothing here is marked `exact` beyond the states themselves.
 */
export function dryRunOverlay(graph: RoutineGraph, steps: readonly DryRunStep[]): RunOverlay {
  const overlay: RunOverlay = { lastSeq: steps.length, nodes: {}, edges: {} };
  for (const step of steps) {
    const source = stateId(step.stateName);
    overlay.nodes[source] = {
      status: "completed",
      exact: true,
      input: step.input,
      output:
        step.output && typeof step.output === "object" && !Array.isArray(step.output)
          ? (step.output as Record<string, unknown>)
          : undefined,
    };
    if (!step.next) continue;
    const target = step.next.kind === "transition" ? stateId(step.next.target) : "end";
    const edge = graph.edges.find((entry) => entry.source === source && entry.target === target);
    if (edge) overlay.edges[edge.id] = { status: "taken" };
  }
  return overlay;
}

/**
 * Rehearses the published Routine.
 *
 * Goes to the Routine's own dry-run route rather than the authoring one: authoring validates a
 * *draft edit*, and refuses any candidate that is not the next authored version, so it can never
 * rehearse the definition that is actually live. Rehearsing needs the same right as running,
 * because a reader who may not start a Run has no business seeing what one would do.
 */
export async function dryRunRoutine(
  slug: string,
  inputs: Record<string, unknown>,
  deps: {
    post?: (path: string, body: unknown) => Promise<DryRunResponse>;
    now?: () => number;
  } = {}
): Promise<DryRunResult> {
  const post = deps.post ?? (<T>(path: string, body: unknown) => apiWrite<T>("POST", path, body));
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const result = await post(
    `/api/v1/routines/${encodeURIComponent(slug)}/dry-run`,
    Object.keys(inputs).length ? { inputs } : {}
  );
  return { ...result, durationMs: now() - started };
}
