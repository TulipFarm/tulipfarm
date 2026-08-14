import { LOG_SERVICES, type LogService } from "./logs";

/** Sampled services alias the log-spine service set; `apps/web` has no Node server. */
export type ResourceService = LogService;
export const RESOURCE_SERVICES: readonly ResourceService[] = LOG_SERVICES;

export const RESOURCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const RESOURCE_SAMPLE_INTERVAL_MS = 60_000;

export interface ResourceSampleRecord {
  readonly id: string;
  readonly ts: Date;
  readonly service: ResourceService;
  readonly instance: string;
  /** Percent of one core over the interval; >100 is valid under thread pools. */
  readonly cpuPct: number;
  readonly rssBytes: number;
}

export interface ResourceReading {
  readonly cpuMicros: number;
  readonly rssBytes: number;
  readonly nowMs: number;
}

export type ResourceProbe = () => ResourceReading;

/** Structural process subset avoids forcing Node types on non-Node consumers. */
export interface ProcessRuntime {
  cpuUsage(): { user: number; system: number };
  memoryUsage(): { rss: number };
}

/** Sums user and system CPU time; the split is not charted. */
export function processResourceProbe(
  runtime: ProcessRuntime,
  now: () => number = Date.now
): ResourceProbe {
  return () => {
    const cpu = runtime.cpuUsage();
    return {
      cpuMicros: cpu.user + cpu.system,
      rssBytes: runtime.memoryUsage().rss,
      nowMs: now(),
    };
  };
}

export interface ResourceWriter {
  write(record: ResourceSampleRecord): Promise<void>;
}

export interface ResourceQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export class PgResourceWriter implements ResourceWriter {
  constructor(private readonly database: ResourceQueryable) {}

  async write(record: ResourceSampleRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO resource_sample (id, ts, service, instance, cpu_pct, rss_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        record.id,
        record.ts,
        record.service,
        record.instance,
        record.cpuPct,
        Math.round(record.rssBytes),
      ]
    );
  }
}

/** Swept by the same consumer as `obs_event` and `log_event`. */
export class PgResourceSamplePruner {
  constructor(private readonly database: ResourceQueryable) {}

  async deleteOlderThan(cutoff: Date): Promise<number> {
    // Queryable exposes `rows`, not `rowCount`, across pg and PGlite.
    const result = await this.database.query(
      "DELETE FROM resource_sample WHERE ts < $1 RETURNING id",
      [cutoff]
    );
    return result.rows.length;
  }
}

export interface ResourceSamplerOptions {
  readonly service: ResourceService;
  readonly instance: string;
  readonly probe: ResourceProbe;
  readonly writer: ResourceWriter;
  readonly intervalMs?: number;
  readonly newId?: () => string;
  readonly schedule?: (callback: () => void, intervalMs: number) => () => void;
  readonly onWriteError?: (error: unknown) => void;
}

interface PlatformGlobals {
  crypto?: { randomUUID?: () => string };
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  console?: { error: (message: string) => void };
}

const platform = globalThis as PlatformGlobals;

function defaultNewId(): string {
  const generate = platform.crypto?.randomUUID;
  if (!generate) {
    throw new Error("ResourceSampler: no globalThis.crypto.randomUUID; pass options.newId");
  }
  return generate.call(platform.crypto);
}

function defaultSchedule(callback: () => void, intervalMs: number): () => void {
  const start = platform.setInterval;
  if (!start) {
    throw new Error("ResourceSampler: no globalThis.setInterval; pass options.schedule");
  }
  const timer = start(callback, intervalMs);
  // Never hold the event loop open on account of telemetry.
  (timer as { unref?: () => void })?.unref?.();
  return () => platform.clearInterval?.(timer);
}

function defaultWriteError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  platform.console?.error(`[observability] resource sample write failed: ${detail}`);
}

/** CPU percent is delta-derived, per-core, baseline-gated, and non-fatal to the process. */
export class ResourceSampler {
  private previous: ResourceReading | null = null;
  private stopTimer: (() => void) | null = null;
  private pending: Promise<void> | null = null;

  private readonly intervalMs: number;
  private readonly newId: () => string;
  private readonly schedule: (callback: () => void, intervalMs: number) => () => void;
  private readonly onWriteError: (error: unknown) => void;

  constructor(private readonly options: ResourceSamplerOptions) {
    this.intervalMs = options.intervalMs ?? RESOURCE_SAMPLE_INTERVAL_MS;
    this.newId = options.newId ?? defaultNewId;
    this.schedule = options.schedule ?? defaultSchedule;
    this.onWriteError = options.onWriteError ?? defaultWriteError;
  }

  /** Idempotent; takes the baseline immediately so the first written sample is real. */
  start(): void {
    if (this.stopTimer) return;
    this.previous = this.read();
    this.stopTimer = this.schedule(() => this.tick(), this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopTimer?.();
    this.stopTimer = null;
    this.previous = null;
    await this.pending?.catch(() => undefined);
    this.pending = null;
  }

  /** Exposed for tests and final shutdown sample; never throws. */
  tick(): void {
    const current = this.read();
    if (!current) return;
    const previous = this.previous;
    this.previous = current;
    if (!previous) return;
    // Slow datastore: drop this point; the next sample spans a wider interval.
    if (this.pending) return;

    const record = deriveSample(previous, current, {
      id: this.newId(),
      service: this.options.service,
      instance: this.options.instance,
    });
    if (!record) return;

    // Callback runs after `done` binds; identity check prevents stale writes clearing newer slots.
    const done: Promise<void> = this.options.writer
      .write(record)
      .catch((error: unknown) => this.onWriteError(error))
      .finally(() => {
        if (this.pending === done) this.pending = null;
      });
    this.pending = done;
  }

  private read(): ResourceReading | null {
    try {
      return this.options.probe();
    } catch (error) {
      this.onWriteError(error);
      return null;
    }
  }
}

/** Converts two cumulative readings into one testable sample, or `null` for dishonest rates. */
export function deriveSample(
  previous: ResourceReading,
  current: ResourceReading,
  identity: { id: string; service: ResourceService; instance: string }
): ResourceSampleRecord | null {
  const wallMs = current.nowMs - previous.nowMs;
  const cpuMicros = current.cpuMicros - previous.cpuMicros;
  // Non-positive intervals or negative CPU deltas cannot yield honest rates.
  if (!(wallMs > 0) || !(cpuMicros >= 0)) return null;
  if (!Number.isFinite(current.rssBytes) || current.rssBytes < 0) return null;

  const cpuPct = (100 * cpuMicros) / (wallMs * 1000);
  if (!Number.isFinite(cpuPct)) return null;

  return {
    id: identity.id,
    ts: new Date(current.nowMs),
    service: identity.service,
    instance: identity.instance,
    cpuPct,
    rssBytes: current.rssBytes,
  };
}
