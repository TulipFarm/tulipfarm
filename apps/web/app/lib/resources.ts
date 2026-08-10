import { apiGet } from "./api";

/*
 * Read-only client for per-process CPU and memory samples (GET /api/v1/observability/resources).
 * Admin-only on the API; a non-admin call throws ApiError(403). Mirrors the other lib/ wrappers.
 */

export type ResourceService = "api" | "worker" | "integration-worker";
export type ResourceWindow = "1h" | "6h" | "24h";
export type ResourceMetric = "cpu" | "memory";

export const RESOURCE_WINDOWS: readonly ResourceWindow[] = ["1h", "6h", "24h"];

/** `null` marks a bucket the service reported no sample for — an outage, not a zero. */
export type ResourceSeries = {
  service: ResourceService;
  cpuPct: (number | null)[];
  rssBytes: (number | null)[];
};

export type ResourceUsage = {
  window: ResourceWindow;
  bucketSeconds: number;
  buckets: string[];
  series: ResourceSeries[];
};

export const EMPTY_RESOURCE_USAGE: ResourceUsage = {
  window: "1h",
  bucketSeconds: 60,
  buckets: [],
  series: [],
};

export async function getResources(window: ResourceWindow = "1h"): Promise<ResourceUsage> {
  return apiGet<ResourceUsage>(`/api/v1/observability/resources?window=${window}`);
}

/** One decimal place: CPU below 0.1% of a core is noise, and above 100% the integer part carries it. */
export function formatCpuPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

/** Binary units, matching what `top`/`htop` report, so the two can be compared directly. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 MB";
  const mb = value / 1024 ** 2;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/**
 * Bucket tick label. Every window here is a day or less, so the date is redundant — every point
 * shares it — and the clock time is what an operator correlates against a deploy or an alert.
 */
export function formatBucketLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
