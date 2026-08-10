import { Writable } from "node:stream";
import type { BatchingLogSink, LogEventLevel } from "@tulipfarm/observability";

/** pino numeric levels. Anything below `error` is not captured — see `LogEventLevel`. */
const PINO_ERROR = 50;
const PINO_FATAL = 60;

/** Keys pino/Fastify own on every record; they are columns or noise, never free-form attributes. */
const RESERVED_KEYS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "msg",
  "err",
  "error",
  "reqId",
  "runId",
  "conversationId",
  "v",
]);

function levelOf(value: unknown): LogEventLevel | null {
  if (typeof value !== "number") return null;
  if (value >= PINO_FATAL) return "fatal";
  if (value >= PINO_ERROR) return "error";
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Pull the message and stack out of a pino record. Fastify serializes a thrown error under `err`,
 * but a hand-rolled `log.error({ error }, ...)` puts it under `error` — accept both, because the
 * moment this table matters is the moment someone logged an error the non-standard way.
 */
function describe(record: Record<string, unknown>): { message: string; stack: string | null } {
  const err = (record.err ?? record.error) as Record<string, unknown> | undefined;
  const msg = str(record.msg);
  const errMessage = err && typeof err === "object" ? str(err.message) : null;
  const stack = err && typeof err === "object" ? str(err.stack) : null;
  // A bare `log.error(err)` leaves msg empty; falling back to the error keeps the row readable.
  return { message: msg ?? errMessage ?? "(no message)", stack };
}

function attributesOf(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!RESERVED_KEYS.has(key)) out[key] = value;
  }
  const err = (record.err ?? record.error) as Record<string, unknown> | undefined;
  const type = err && typeof err === "object" ? str(err.type ?? err.name) : null;
  if (type) out.errorType = type;
  return out;
}

/** Feed one already-parsed pino record to the sink, if it is at a captured level. */
export function capturePinoRecord(sink: BatchingLogSink, record: Record<string, unknown>): void {
  const level = levelOf(record.level);
  if (!level) return;
  const { message, stack } = describe(record);
  sink.capture({
    level,
    message,
    stack,
    ts: typeof record.time === "number" ? new Date(record.time) : undefined,
    requestId: str(record.reqId),
    runId: str(record.runId),
    conversationId: str(record.conversationId),
    attributes: attributesOf(record),
  });
}

/**
 * A pino destination that tees: every line still reaches stdout byte-for-byte, and `error`/`fatal`
 * records are additionally buffered for Postgres.
 *
 * stdout is written first and unconditionally. Capture is strictly additive — if parsing fails, or
 * the sink is saturated, the operator has lost nothing they had before this stream existed. Records
 * are reassembled across chunk boundaries because a destination is not promised whole lines.
 */
export function createLogTeeStream(
  sink: BatchingLogSink,
  out: NodeJS.WritableStream = process.stdout
): Writable {
  let pending = "";

  return new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      out.write(text);
      try {
        pending += text;
        const lines = pending.split("\n");
        // The trailing element is either "" (chunk ended on a newline) or a partial line to keep.
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length === 0) continue;
          capturePinoRecord(sink, JSON.parse(line) as Record<string, unknown>);
        }
        // A line that never terminates must not grow without bound.
        if (pending.length > 1_000_000) pending = "";
      } catch {
        // Non-JSON or malformed output is not a reason to break logging. Drop the partial buffer so
        // one bad line cannot poison every line after it.
        pending = "";
      }
      callback();
    },
  });
}
