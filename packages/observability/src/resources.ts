import { LOG_SERVICES, type LogService } from "./logs";

/**
 * The services that sample themselves. Identical to the log spine's set by construction — the same
 * three long-lived processes — so it is aliased rather than redeclared, keeping one source of truth
 * for "which processes exist". (`apps/web` is a Vite/Remix build with no Node server of its own.)
 */
export type ResourceService = LogService;
export const RESOURCE_SERVICES: readonly ResourceService[] = LOG_SERVICES;

/** Default retention for fixed-cadence samples: 7 days. */
export const RESOURCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Default sampling cadence. Matches the narrowest chart bucket, so one row is one point. */
export const RESOURCE_SAMPLE_INTERVAL_MS = 60_000;

export interface ResourceSampleRecord {
  readonly id: string;
  readonly ts: Date;
  readonly service: ResourceService;
  readonly instance: string;
  /** Percent of a *single* core over the elapsed interval; >100 is legitimate under thread pools. */
  readonly cpuPct: number;
  readonly rssBytes: number;
}

/**
 * A single reading of the host process, supplied by the app rather than taken here.
 *
 * CPU is reported as a **cumulative** counter (microseconds of CPU consumed since process start),
 * not a rate, because that is the only thing a process can actually observe about itself —
 * the rate is a property of an interval and is derived below.
 */
export interface ResourceReading {
  readonly cpuMicros: number;
  readonly rssBytes: number;
  readonly nowMs: number;
}

export type ResourceProbe = () => ResourceReading;

/**
 * The two methods of Node's `process` that a sample needs. Declared structurally so this file keeps
 * compiling without `types: ["node"]` — `processResourceProbe(process)` type-checks in every app
 * without the package forcing a Node environment on any other consumer.
 */
export interface ProcessRuntime {
  cpuUsage(): { user: number; system: number };
  memoryUsage(): { rss: number };
}

/** Adapts a `process`-shaped runtime into a probe. User and system time are summed: a process is */
/** just as busy blocking in a syscall as it is in userland, and the split is not charted. */
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

/** The minimal database surface the sampler needs — matches `ObservabilityQueryable`. */
export interface ResourceQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** The single writer for `resource_sample`, shared by every sampling process. */
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

/** Deletes expired samples. Swept by the same consumer as `obs_event` and `log_event`. */
export class PgResourceSamplePruner {
  constructor(private readonly database: ResourceQueryable) {}

  async deleteOlderThan(cutoff: Date): Promise<number> {
    // RETURNING id so the count works across the Queryable contract (pg + PGlite), which exposes
    // only `rows`, not `rowCount`. Mirrors PgLogPruner.
    const result = await this.database.query(
      "DELETE FROM resource_sample WHERE ts < $1 RETURNING id",
      [cutoff]
    );
    return result.rows.length;
  }
}

export interface ResourceSamplerOptions {
  readonly service: ResourceService;
  /** Distinguishes replicas of one service, so their samples are averaged rather than conflated. */
  readonly instance: string;
  readonly probe: ResourceProbe;
  readonly writer: ResourceWriter;
  readonly intervalMs?: number;
  /** Injected for the same platform-neutrality reason as in `BatchingLogSink`. */
  readonly newId?: () => string;
  readonly schedule?: (callback: () => void, intervalMs: number) => () => void;
  /** Where write failures are reported. Never routed through the app logger. */
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

/**
 * Samples the host process on an interval and persists the result.
 *
 * CPU utilisation cannot be read; it can only be *differenced*. `process.cpuUsage()` and its
 * equivalents are monotonic counters, so a percentage exists only between two readings:
 * `100 × Δcpu_micros / (Δwall_ms × 1000)`. That makes the first tick after `start()` structurally
 * incapable of producing a value — it establishes the baseline and writes nothing, rather than
 * emitting a bogus reading derived from the process's whole lifetime.
 *
 * The result is percent of a *single* core, matching `top`: a process saturating two cores reads
 * 200%. Normalising by core count was rejected because it would make a fully pegged single-threaded
 * Node process — the actual failure mode worth seeing — render as a small fraction on a big host.
 *
 * As with the log sink, observing a process must never harm it: a probe that throws, a clock that
 * moves backwards, and a database that is down are all survivable and none propagate. At most one
 * write is ever in flight; if one is still pending when the next tick fires, that tick updates the
 * baseline but skips its write, so a stalled database cannot accumulate pending promises. The
 * following sample then covers the longer interval and stays arithmetically correct.
 */
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

  /** Idempotent. Takes the baseline reading immediately so the first written sample is real. */
  start(): void {
    if (this.stopTimer) return;
    this.previous = this.read();
    this.stopTimer = this.schedule(() => this.tick(), this.intervalMs);
  }

  /** Stops sampling and awaits any in-flight write. Safe to call when never started. */
  async stop(): Promise<void> {
    this.stopTimer?.();
    this.stopTimer = null;
    this.previous = null;
    await this.pending?.catch(() => undefined);
    this.pending = null;
  }

  /** Exposed for tests and for a final sample on shutdown; never throws. */
  tick(): void {
    const current = this.read();
    if (!current) return;
    const previous = this.previous;
    this.previous = current;
    if (!previous) return;
    // A write still in flight means the datastore is slow; drop this point rather than queue behind
    // it. The baseline has already advanced, so the next sample simply spans a wider interval.
    if (this.pending) return;

    const record = deriveSample(previous, current, {
      id: this.newId(),
      service: this.options.service,
      instance: this.options.instance,
    });
    if (!record) return;

    // `done` is referenced inside its own initializer, which is safe: the callback runs in a later
    // microtask, after the binding exists. Comparing identity before clearing means a slow write
    // that outlives a newer one cannot null out the newer one's slot.
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

/**
 * Turns two cumulative readings into one sample, or `null` when the pair cannot yield an honest
 * value. Exported so the arithmetic is testable without a timer.
 */
export function deriveSample(
  previous: ResourceReading,
  current: ResourceReading,
  identity: { id: string; service: ResourceService; instance: string }
): ResourceSampleRecord | null {
  const wallMs = current.nowMs - previous.nowMs;
  const cpuMicros = current.cpuMicros - previous.cpuMicros;
  // A non-positive interval (duplicate tick, clock stepped backwards) has no rate. A negative CPU
  // delta means the counter is not the monotonic one this assumes; in both cases emitting anything
  // would be inventing data.
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
