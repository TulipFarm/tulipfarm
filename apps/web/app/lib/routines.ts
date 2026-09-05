import type { routine as routineSchema, TeamBusinessAssetOwnership } from "@tulipfarm/schema";
import { apiGet, apiWrite } from "./api";

/* Cookie-first routines client. */

export type RoutineTrigger = {
  slug: string;
  type: string;
  summary: string;
};

/** A coarse consequence kind, as the catalog reads it from the Routine document. */
export type RoutineEffectKind =
  | "agent"
  | "tool"
  | "child_routine"
  | "event"
  | "script"
  | "human"
  | "wait";

export type RiskClass = "low" | "medium" | "high";

/** What the catalog derived from the Routine document, so the list need not fetch each one. */
export type RoutineCatalogSummary = {
  owner: string | null;
  ownership?: TeamBusinessAssetOwnership;
  stateCount: number;
  stateTypes: string[];
  effects: RoutineEffectKind[];
  toolAbilities: string[];
  /** `null` is "no ceiling declared", which is less constrained than `high` — never "low". */
  maxRiskClass: RiskClass | null;
  requiresApproval: boolean;
  concurrencyPolicy: string | null;
  compensationPolicy: string | null;
};

export type RoutineSummary = {
  id: string;
  slug: string;
  displayName: string | null;
  authoredVersion: number;
  triggers: RoutineTrigger[];
  summary: RoutineCatalogSummary;
};

/** One published Routine, as the verified active bundle carries it. */
export type RoutineDetail = RoutineSummary & {
  definition: routineSchema.RoutineDefinition;
  /** The bundle digest this document came from, so a stale view is detectable. */
  hash: string;
};

/** The `spec.input` JSON Schema subset the manual-trigger form renders. */
export type RoutineInputsSchema = {
  type?: string;
  required?: string[];
  properties?: Record<
    string,
    { type?: string; description?: string; enum?: Array<string | number> }
  >;
};

export type RunStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "attention_required"
  | "needs_reconciliation";

export type RunSummary = {
  id: string;
  routineSlug: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
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

export async function triggerRun(
  slug: string,
  inputs: Record<string, unknown>
): Promise<{ runId: string }> {
  return apiWrite<{ runId: string }>("POST", `/api/v1/routines/${encodeURIComponent(slug)}/runs`, {
    inputs,
  });
}
