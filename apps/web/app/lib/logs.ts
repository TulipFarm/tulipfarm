import { apiGet } from "./api";

/*
 * Read-only client for the error log spine (GET /api/v1/observability/logs).
 * Admin-only on the API; a non-admin call throws ApiError(403). Mirrors the other lib/ wrappers.
 */

export type LogEventLevel = "error" | "fatal";
export type LogService = "api" | "worker" | "integration-worker";

export const LOG_LEVELS: readonly LogEventLevel[] = ["error", "fatal"];
export const LOG_SERVICES: readonly LogService[] = ["api", "worker", "integration-worker"];

export type LogEvent = {
  id: string;
  ts: string;
  level: LogEventLevel;
  service: LogService;
  message: string;
  stack: string | null;
  requestId: string | null;
  runId: string | null;
  conversationId: string | null;
  attributes: Record<string, unknown>;
};

export type LogPage = {
  items: LogEvent[];
  nextCursor: string | null;
};

export type LogFilters = {
  level?: LogEventLevel;
  service?: LogService;
  q?: string;
  limit?: number;
  cursor?: string;
};

export async function getLogs(filters: LogFilters = {}): Promise<LogPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const query = params.toString();
  return apiGet<LogPage>(`/api/v1/observability/logs${query ? `?${query}` : ""}`);
}

/**
 * Absolute local time to the second. Log triage is about correlating an entry with a deploy or a
 * user report, and "5 minutes ago" cannot be matched against either.
 */
export function formatLogTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
