import { redactAttributes } from "./resilience";

/**
 * Only failures are captured. Warn-and-below would multiply row volume for records nobody opens,
 * and the point of this spine is that an operator can find the thing that actually broke.
 */
export type LogEventLevel = "error" | "fatal";

/** Which process emitted the record. A fixed set — it names deployment topology, not free text. */
export type LogService = "api" | "worker" | "integration-worker";

export const LOG_EVENT_LEVELS: readonly LogEventLevel[] = ["error", "fatal"];
export const LOG_SERVICES: readonly LogService[] = ["api", "worker", "integration-worker"];

export function isLogEventLevel(value: unknown): value is LogEventLevel {
  return LOG_EVENT_LEVELS.includes(value as LogEventLevel);
}

export function isLogService(value: unknown): value is LogService {
  return LOG_SERVICES.includes(value as LogService);
}

/** A durable log record. `stack` is present when the record came from a thrown error. */
export interface LogEventRecord {
  id: string;
  ts: Date;
  level: LogEventLevel;
  service: LogService;
  message: string;
  stack: string | null;
  requestId: string | null;
  runId: string | null;
  conversationId: string | null;
  attributes: Record<string, unknown>;
}

/** What the sink needs to persist a batch. Implemented per app over its own database handle. */
export interface LogWriter {
  insertMany(rows: readonly LogEventRecord[]): Promise<void>;
}

/** The minimal database surface the log spine needs — matches `ObservabilityQueryable`. */
export interface LogQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

const INSERT_COLUMNS = 10;

/** Shared `log_event` writer; flushes use one multi-row INSERT. */
export class PgLogWriter implements LogWriter {
  constructor(private readonly database: LogQueryable) {}

  async insertMany(rows: readonly LogEventRecord[]): Promise<void> {
    if (rows.length === 0) return;
    const values: unknown[] = [];
    const tuples = rows.map((row, i) => {
      const base = i * INSERT_COLUMNS;
      values.push(
        row.id,
        row.ts,
        row.level,
        row.service,
        row.message,
        row.stack,
        row.requestId,
        row.runId,
        row.conversationId,
        JSON.stringify(row.attributes)
      );
      const p = (n: number) => `$${base + n}`;
      // created_at reuses the ts placeholder: a record is written at the moment it is emitted.
      return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}::jsonb, ${p(2)})`;
    });
    await this.database.query(
      `INSERT INTO log_event
         (id, ts, level, service, message, stack, request_id, run_id, conversation_id, attributes, created_at)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (id) DO NOTHING`,
      values
    );
  }
}

/** Deletes expired log records. Swept on the same schedule as `obs_event`. */
export class PgLogPruner {
  constructor(private readonly database: LogQueryable) {}

  async deleteOlderThan(cutoff: Date): Promise<number> {
    // Use `RETURNING` because Queryable exposes rows, not rowCount.
    const result = await this.database.query("DELETE FROM log_event WHERE ts < $1 RETURNING id", [
      cutoff,
    ]);
    return result.rows.length;
  }
}

export interface LogCapture {
  level: LogEventLevel;
  message: string;
  stack?: string | null;
  requestId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  attributes?: Record<string, unknown>;
  ts?: Date;
}

export interface BatchingLogSinkOptions {
  service: LogService;
  writer: LogWriter;
  /** Flush cadence. Default 2s — fast enough to feel live, slow enough to batch a burst. */
  flushIntervalMs?: number;
  /** Flush immediately once this many records are buffered. Default 50. */
  batchSize?: number;
  /** Hard ceiling on buffered records. Default 500. */
  maxBuffer?: number;
  now?: () => Date;
  /** Record id generator; injected to keep this package platform-neutral. */
  newId?: () => string;
  /**
   * Where a failed write is reported. Defaults to `console.error`, the one logging call that is
   * guaranteed not to re-enter this sink (the app loggers tee into `capture`, `console` does not).
   */
  onWriteError?: (message: string) => void;
  /** Periodic scheduler. Injected for the same platform-neutrality reason as `newId`. */
  schedule?: (callback: () => void, intervalMs: number) => () => void;
}

const MESSAGE_MAX = 8_000;
const STACK_MAX = 16_000;
/** Ceiling on `stop()` flush passes so logging cannot stall process exit. */
const STOP_MAX_PASSES = 5;

/** Narrow platform globals so consumers do not inherit Node or DOM types. */
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
    throw new Error("BatchingLogSink: no globalThis.crypto.randomUUID; pass options.newId");
  }
  return generate.call(platform.crypto);
}

function defaultSchedule(callback: () => void, intervalMs: number): () => void {
  const start = platform.setInterval;
  if (!start) {
    throw new Error("BatchingLogSink: no globalThis.setInterval; pass options.schedule");
  }
  const timer = start(callback, intervalMs);
  // Never hold the event loop open on account of telemetry.
  (timer as { unref?: () => void })?.unref?.();
  return () => platform.clearInterval?.(timer);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`;
}

/** Bounded, non-throwing log sink; overflow drops newest and reports loss on next flush. */
export class BatchingLogSink {
  private buffer: LogEventRecord[] = [];
  private dropped = 0;
  private stopTimer: (() => void) | null = null;
  private flushing: Promise<void> | null = null;
  private readonly service: LogService;
  private readonly writer: LogWriter;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxBuffer: number;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly onWriteError: (message: string) => void;
  private readonly schedule: (callback: () => void, intervalMs: number) => () => void;

  constructor(options: BatchingLogSinkOptions) {
    this.service = options.service;
    this.writer = options.writer;
    this.flushIntervalMs = options.flushIntervalMs ?? 2_000;
    this.batchSize = options.batchSize ?? 50;
    this.maxBuffer = options.maxBuffer ?? 500;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultNewId;
    this.onWriteError = options.onWriteError ?? ((message) => platform.console?.error(message));
    this.schedule = options.schedule ?? defaultSchedule;
  }

  /** Records dropped since the last successful flush. Exposed for tests and diagnostics. */
  get droppedCount(): number {
    return this.dropped;
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  /** Buffer one record. Never throws, never awaits, never blocks the caller. */
  capture(input: LogCapture): void {
    try {
      if (this.buffer.length >= this.maxBuffer) {
        this.dropped += 1;
        return;
      }
      this.buffer.push(this.toRecord(input));
      if (this.buffer.length >= this.batchSize) void this.flush();
    } catch {
      // A malformed record must not propagate into the code path that emitted it.
      this.dropped += 1;
    }
  }

  private toRecord(input: LogCapture): LogEventRecord {
    return {
      id: this.newId(),
      ts: input.ts ?? this.now(),
      level: input.level,
      service: this.service,
      message: truncate(input.message, MESSAGE_MAX),
      stack: input.stack ? truncate(input.stack, STACK_MAX) : null,
      requestId: input.requestId ?? null,
      runId: input.runId ?? null,
      conversationId: input.conversationId ?? null,
      // Redaction happens on write, not on read: a secret that reaches the table is already leaked.
      attributes: redactAttributes(input.attributes ?? {}),
    };
  }

  /** Persist everything buffered. Serialized — a tick during a slow write joins it, never races. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = this.drain().finally(() => {
      this.flushing = null;
    });
    this.flushing = run;
    return run;
  }

  private async drain(): Promise<void> {
    if (this.buffer.length === 0 && this.dropped === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const dropped = this.dropped;
    this.dropped = 0;
    if (dropped > 0) {
      batch.push(
        this.toRecord({
          level: "error",
          message: `[observability] log sink dropped ${dropped} record(s): buffer limit ${this.maxBuffer} reached`,
        })
      );
    }
    try {
      await this.writer.insertMany(batch);
    } catch (error) {
      // Do not log or requeue here: both can loop or grow memory during storage failure.
      const reason = error instanceof Error ? error.message : String(error);
      this.onWriteError(
        `[observability] log sink write failed, ${batch.length} record(s) lost: ${reason}`
      );
    }
  }

  start(): void {
    if (this.stopTimer) return;
    this.stopTimer = this.schedule(() => void this.flush(), this.flushIntervalMs);
  }

  /** Stop the timer and flush bounded passes so shutdown cannot stall on new records. */
  async stop(): Promise<void> {
    this.stopTimer?.();
    this.stopTimer = null;
    for (let pass = 0; pass < STOP_MAX_PASSES; pass += 1) {
      await this.flush();
      if (this.buffer.length === 0 && this.dropped === 0) return;
    }
  }
}

/** Normalizes Error and non-Error throws into readable log fields. */
export function describeError(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return { message: error.message || error.name, stack: error.stack ?? null };
  }
  if (typeof error === "string") return { message: error, stack: null };
  try {
    return { message: JSON.stringify(error) ?? String(error), stack: null };
  } catch {
    return { message: String(error), stack: null };
  }
}
