import { apiGet } from "./api";

/*
 * Read-only client for the AI observability dashboard (GET /api/v1/observability/summary).
 * Admin-only on the API; a non-admin call throws ApiError(403). Mirrors the other lib/ wrappers.
 */

export type SummaryRange = "24h" | "7d" | "30d";

export type ObsSummary = {
  totals: { cost: number; tokens: number; turns: number; unpricedCalls: number };
  series: Array<{ bucket: string; cost: number; tokens: number }>;
  byAgent: Array<{ agentId: string; cost: number }>;
  byMember: Array<{ memberId: string; member: string; cost: number }>;
  byModel: Array<{ model: string; cost: number; calls: number; unpriced: boolean }>;
  modelSeries: Array<{ bucket: string; model: string; cost: number }>;
  reliability: {
    turns: number;
    turnErrors: number;
    llmCalls: number;
    llmErrors: number;
    fallbacks: number;
    toolCalls: number;
    toolErrors: number;
    p95DurationMs: number;
  };
};

export async function getObservabilitySummary(range: SummaryRange): Promise<ObsSummary> {
  return apiGet<ObsSummary>(`/api/v1/observability/summary?range=${range}`);
}

export type ObsConfigStatus = {
  enabled: boolean;
  otlpConfigured: boolean;
  endpoint: string | null;
  retentionDays: number;
  captureContent: boolean;
  spendAlertUsd: number | null;
};

export async function getObservabilityConfig(): Promise<ObsConfigStatus> {
  return apiGet<ObsConfigStatus>("/api/v1/observability/config");
}

export type RecentTurn = {
  conversationId: string | null;
  agentId: string | null;
  status: string | null;
  tokensIn: number;
  tokensOut: number;
  steps: number;
  ts: string;
};

export type TraceEvent = {
  type: "llm_call" | "tool_call" | "turn" | "job";
  ts: string;
  agentId: string | null;
  model: string | null;
  provider: string | null;
  tier: string | null;
  status: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  durationMs: number | null;
  toolName: string | null;
  attributes: Record<string, unknown>;
};

export async function getRecentTurns(limit = 25): Promise<RecentTurn[]> {
  return apiGet<RecentTurn[]>(`/api/v1/observability/recent?limit=${limit}`);
}

export async function getTrace(conversationId: string): Promise<TraceEvent[]> {
  return apiGet<TraceEvent[]>(`/api/v1/observability/trace/${encodeURIComponent(conversationId)}`);
}

/** Percentage string for an error/fallback rate (0 when the denominator is 0). */
export function rate(numerator: number, denominator: number): string {
  if (denominator <= 0) return "0%";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/** Money for headline cards: cents precision, but sub-cent spend shows more digits so it isn't
 *  $0.00. `currencyCode` is the business's chosen display currency (default USD) — `Intl.NumberFormat`
 *  natively formats any valid ISO 4217 code, so no lookup table is needed here. */
export function formatCost(n: number, currencyCode = "USD"): string {
  if (n > 0 && n < 0.01) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    }).format(n);
  }
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: 2,
  }).format(n);
}

/** Compact token counts: 1.2M / 4.5k / 320. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
