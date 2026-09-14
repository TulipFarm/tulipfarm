import { apiGet, apiWrite } from "./api";

export type TelemetryLevel = 0 | 1 | 2;

export type TelemetrySettings = {
  level: TelemetryLevel;
  effectiveLevel: TelemetryLevel;
  maxLevel: TelemetryLevel;
  enabled: boolean;
  configured: boolean;
  installationId: string;
  bootstrapSentAt: string | null;
  lastSnapshotAt: string | null;
  preview: {
    bootstrap: Record<string, unknown> | null;
    snapshot: Record<string, unknown> | null;
  };
};

export function getTelemetry(level?: TelemetryLevel): Promise<TelemetrySettings> {
  return apiGet(`/api/v1/system/telemetry${level === undefined ? "" : `?level=${level}`}`);
}

export function saveTelemetry(level: TelemetryLevel): Promise<TelemetrySettings> {
  return apiWrite("PUT", "/api/v1/system/telemetry", { level });
}
