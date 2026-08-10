import { RESOURCE_SERVICES, type ResourceService } from "@tulipfarm/observability";
import type { Queryable } from "../db";

/** The windows the dashboard offers, each paired with a bucket that keeps the point count sane. */
export const RESOURCE_WINDOWS = {
  "1h": { minutes: 60, bucketSeconds: 60 },
  "6h": { minutes: 360, bucketSeconds: 300 },
  "24h": { minutes: 1440, bucketSeconds: 900 },
} as const;

export type ResourceWindow = keyof typeof RESOURCE_WINDOWS;

export const RESOURCE_WINDOW_KEYS = Object.keys(RESOURCE_WINDOWS) as ResourceWindow[];

export function isResourceWindow(value: unknown): value is ResourceWindow {
  return typeof value === "string" && value in RESOURCE_WINDOWS;
}

/**
 * One service's aligned readings. Every array is the same length as `buckets`, and `null` marks a
 * bucket the service produced no sample for — which is the honest rendering of a process that was
 * down or had not started yet, and is what lets the chart draw a gap instead of a straight line
 * across the outage.
 */
export interface ResourceSeries {
  service: ResourceService;
  cpuPct: (number | null)[];
  rssBytes: (number | null)[];
}

export interface ResourceUsage {
  window: ResourceWindow;
  bucketSeconds: number;
  /** ISO bucket-start timestamps, ascending. */
  buckets: string[];
  series: ResourceSeries[];
}

type QueryRow = Record<string, unknown>;

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

export interface ResourceRepo {
  usage(window: ResourceWindow, now?: Date): Promise<ResourceUsage>;
}

export class PgResourceRepo implements ResourceRepo {
  constructor(private readonly q: Queryable) {}

  async usage(window: ResourceWindow, now: Date = new Date()): Promise<ResourceUsage> {
    const { minutes, bucketSeconds } = RESOURCE_WINDOWS[window];
    const since = new Date(now.getTime() - minutes * 60_000);

    // `date_trunc` only accepts named units, so anything other than a whole minute needs the
    // epoch-floor form. Bucket width is a bound param taken from the table above, never user input.
    // AVG collapses replicas of one service into one line: summing would report a fleet's combined
    // CPU as if one process were burning it, and MAX would hide a quiet majority behind one hot pod.
    const result = await this.q.query(
      `SELECT to_timestamp(floor(extract(epoch FROM ts) / $2::float8) * $2::float8) AS bucket,
              service,
              AVG(cpu_pct)::float8   AS cpu_pct,
              AVG(rss_bytes)::float8 AS rss_bytes
         FROM resource_sample
        WHERE ts >= $1
        GROUP BY 1, 2
        ORDER BY 1 ASC`,
      [since, bucketSeconds]
    );

    return shapeUsage(result.rows as QueryRow[], window, bucketSeconds);
  }
}

/**
 * Pivots (bucket, service) rows into per-service arrays aligned to a shared bucket axis. Exported
 * for tests: the alignment is the part that silently breaks, not the SQL.
 */
export function shapeUsage(
  rows: readonly QueryRow[],
  window: ResourceWindow,
  bucketSeconds: number
): ResourceUsage {
  const bucketIndex = new Map<string, number>();
  const buckets: string[] = [];
  for (const row of rows) {
    const iso = toIso(row.bucket);
    if (!bucketIndex.has(iso)) {
      bucketIndex.set(iso, buckets.length);
      buckets.push(iso);
    }
  }

  const byService = new Map<string, ResourceSeries>();
  for (const row of rows) {
    const name = String(row.service);
    // A service name outside the known three would be a row from a future or renamed process. The
    // typed contract only promises the closed set, so it is skipped rather than charted unlabelled.
    if (!RESOURCE_SERVICES.includes(name as ResourceService)) continue;
    let series = byService.get(name);
    if (!series) {
      series = {
        service: name as ResourceService,
        cpuPct: new Array(buckets.length).fill(null),
        rssBytes: new Array(buckets.length).fill(null),
      };
      byService.set(name, series);
    }
    const i = bucketIndex.get(toIso(row.bucket));
    if (i === undefined) continue;
    series.cpuPct[i] = toNumber(row.cpu_pct);
    series.rssBytes[i] = toNumber(row.rss_bytes);
  }

  // Stable order so a service does not swap colours between refreshes.
  const series = RESOURCE_SERVICES.map((s) => byService.get(s)).filter(
    (s): s is ResourceSeries => s !== undefined
  );

  return { window, bucketSeconds, buckets, series };
}
