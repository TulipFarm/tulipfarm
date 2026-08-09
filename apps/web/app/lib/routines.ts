import type { RoutineDefinition } from "@tulipfarm/schema";
import { API_BASE, apiGet, apiWrite } from "./api";

/*
 * Client for the routines API (v0.11). Mirrors lib/agents.ts conventions (cookie-first
 * auth, ApiError on non-2xx). Live run progress streams from the run SSE endpoint —
 * `runEventsUrl` builds the EventSource URL (cookies ride along via withCredentials).
 */

export type RoutineTrigger = {
  slug: string;
  type: string;
  summary: string;
};

export type RoutineSummary = {
  id: string;
  slug: string;
  displayName: string | null;
  authoredVersion: number;
  triggers: RoutineTrigger[];
};

export type RoutineDetail =
  | {
      slug: string;
      valid: true;
      definition: RoutineDefinition;
      hash: string;
      hasHooks: boolean;
    }
  | { slug: string; valid: false; loadError: string };

/** The x-inputs JSON Schema subset the manual-trigger form renders. */
export type RoutineInputsSchema = {
  type?: string;
  required?: string[];
  properties?: Record<
    string,
    { type?: string; description?: string; enum?: Array<string | number> }
  >;
};

export type RunStatus =
  | "pending"
  | "running"
  | "sleeping"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RunSummary = {
  id: string;
  routineSlug: string;
  status: RunStatus;
  currentState?: string | null;
  trigger?: { type: string; triggerIndex?: number };
  output?: unknown;
  error?: { name?: string; message?: string } | null;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string | null;
};

export type RunEvent = {
  seq: number;
  type: string;
  payload?: unknown;
  createdAt?: string;
};

export type RunDetail = {
  run: RunSummary & {
    context?: Record<string, unknown>;
    definitionHash?: string;
    definitionSnapshot: RoutineDefinition;
    attemptCounts?: Record<string, number>;
    approvalId?: string | null;
  };
  events: RunEvent[];
};

export async function listRoutines(): Promise<RoutineSummary[]> {
  const body = await apiGet<{ items: RoutineSummary[] }>("/api/v1/routines");
  return body.items;
}

export async function getRoutine(slug: string): Promise<RoutineDetail> {
  return apiGet<RoutineDetail>(`/api/v1/routines/${encodeURIComponent(slug)}`);
}

export async function listRuns(slug: string, limit = 50): Promise<RunSummary[]> {
  const body = await apiGet<{ items: RunSummary[] }>(
    `/api/v1/routines/${encodeURIComponent(slug)}/runs?limit=${limit}`
  );
  return body.items;
}

export async function getRun(slug: string, runId: string): Promise<RunDetail> {
  return apiGet<RunDetail>(
    `/api/v1/routines/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}`
  );
}

export async function triggerRun(
  slug: string,
  inputs: Record<string, unknown>
): Promise<{ runId: string }> {
  return apiWrite<{ runId: string }>("POST", `/api/v1/routines/${encodeURIComponent(slug)}/runs`, {
    inputs,
  });
}

export async function cancelRun(slug: string, runId: string): Promise<void> {
  await apiWrite(
    "POST",
    `/api/v1/routines/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}/cancel`,
    {}
  );
}

export function runEventsUrl(slug: string, runId: string, lastEventId?: number): string {
  const base = `${API_BASE}/api/v1/routines/${encodeURIComponent(slug)}/runs/${encodeURIComponent(
    runId
  )}/events`;
  return lastEventId ? `${base}?lastEventId=${lastEventId}` : base;
}
