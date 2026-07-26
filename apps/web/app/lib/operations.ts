import { apiCommand, apiGet } from "./api";

export type RunCommandAction = "pause" | "resume" | "cancel" | "retry" | "reconcile";

export type OperationalRun = {
  id: string;
  routineId: string;
  routineVersion: string;
  status: string;
  version: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  states: Array<{
    key: string;
    status: string;
    attempts: number;
    input?: unknown;
    output?: unknown;
    errorEvidenceRef?: string;
  }>;
  effects: Array<Record<string, unknown>>;
  waits: Array<Record<string, unknown>>;
  guardrailDecisions: Array<Record<string, unknown>>;
  lineage: Array<Record<string, unknown>>;
  costs: { amountUsd: number; modelTokens: number };
};

export async function getOperationalRun(id: string): Promise<OperationalRun> {
  return (await apiGet<{ run: OperationalRun }>(`/api/v1/runs/${encodeURIComponent(id)}`)).run;
}

export function commandRun(
  run: OperationalRun,
  action: RunCommandAction,
  reason: string
): Promise<{ commandId: string; runId: string; status: string }> {
  return apiCommand(
    `/api/v1/runs/${encodeURIComponent(run.id)}/${action}`,
    { expectedVersion: run.version, reason },
    `${action}-${run.id}-v${run.version}`
  );
}

export type OperationsModel = {
  health: Array<Record<string, unknown>>;
  incidents: Array<Record<string, unknown>>;
  quarantine: Array<Record<string, unknown>>;
  killSwitches: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
  recovery: { supportBundleAvailable: boolean; lastBackupAt: string | null };
};

export function getOperations(): Promise<OperationsModel> {
  return apiGet<OperationsModel>("/api/v1/admin/operations");
}

export function commandOperation(
  action: string,
  input: Record<string, unknown>
): Promise<{ commandId: string; status: string }> {
  return apiCommand(
    `/api/v1/admin/operations/${encodeURIComponent(action)}`,
    { input },
    `operation-${action}-${JSON.stringify(input)}`
  );
}
