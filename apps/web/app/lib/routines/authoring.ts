import type { routine as routineSchema } from "@tulipfarm/schema";
import { apiCommand, apiGet, apiWrite } from "../api";
import { randomUUID } from "../uuid";

export interface RoutineAuthoringBase {
  readonly definition: routineSchema.RoutineDefinition;
  readonly baseCommit: string;
}

export interface RoutineAuthoringAnalysis {
  readonly yaml: string;
  readonly validationState: "valid";
  readonly risk: "medium" | "high";
  readonly approval: "required";
  readonly publicationState: "draft";
  readonly simulation: {
    readonly status: "completed";
    readonly resultHash: string;
    readonly steps: readonly { readonly stateName: string }[];
    readonly effects: readonly unknown[];
  };
}

export interface RoutineAuthoringBody {
  readonly baseCommit: string;
  readonly yaml: string;
  readonly fixture: { readonly startedAtMs: number };
}

export async function getRoutineAuthoringBase(slug: string): Promise<RoutineAuthoringBase> {
  return apiGet<RoutineAuthoringBase>(`/api/v1/routines/${encodeURIComponent(slug)}/authoring`);
}

export async function analyzeRoutine(
  slug: string,
  body: RoutineAuthoringBody
): Promise<RoutineAuthoringAnalysis> {
  return apiWrite<RoutineAuthoringAnalysis>(
    "POST",
    `/api/v1/routines/${encodeURIComponent(slug)}/authoring/analyze`,
    body
  );
}

export async function proposeRoutineChangeset(
  slug: string,
  body: RoutineAuthoringBody
): Promise<{ readonly changesetId: string; readonly status: string }> {
  return apiCommand(`/api/v1/routines/${encodeURIComponent(slug)}/changesets`, body, randomUUID());
}
