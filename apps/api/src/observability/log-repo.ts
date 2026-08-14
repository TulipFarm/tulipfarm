import {
  type LogEventLevel,
  type LogEventRecord,
  type LogService,
  type LogWriter,
  PgLogWriter,
} from "@tulipfarm/observability";
import type { Queryable } from "../db";

/** UI log record: ISO timestamps, never `Date`. */
export interface LogEventView {
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
}

export interface LogQuery {
  level?: LogEventLevel;
  service?: LogService;
  since?: Date;
  /** Case-insensitive substring match on `message`. */
  q?: string;
  limit: number;
  /** Keyset cursor from a previous page: `${isoTs}|${id}`. */
  cursor?: string;
}

export interface LogPage {
  items: LogEventView[];
  nextCursor: string | null;
}

export interface LogRepo extends LogWriter {
  query(opts: LogQuery): Promise<LogPage>;
  deleteOlderThan(cutoff: Date): Promise<number>;
}

/** Encode the keyset position of a row. Opaque to the client; parsed only by `decodeCursor`. */
export function encodeCursor(ts: string, id: string): string {
  return `${ts}|${id}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse a cursor; malformed or non-UUID ids fall back to the first page. */
export function decodeCursor(cursor: string): { ts: Date; id: string } | null {
  const idx = cursor.lastIndexOf("|");
  if (idx <= 0) return null;
  const ts = new Date(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (Number.isNaN(ts.getTime()) || !UUID_PATTERN.test(id)) return null;
  return { ts, id };
}

/** Escape LIKE wildcards so someone searching for `100%` doesn't match every row. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const textOrNull = (v: unknown): string | null => (v == null ? null : String(v));

function toView(r: Record<string, unknown>): LogEventView {
  return {
    id: String(r.id),
    ts: iso(r.ts),
    level: r.level as LogEventLevel,
    service: r.service as LogService,
    message: String(r.message),
    stack: textOrNull(r.stack),
    requestId: textOrNull(r.request_id),
    runId: textOrNull(r.run_id),
    conversationId: textOrNull(r.conversation_id),
    attributes: (r.attributes as Record<string, unknown> | null) ?? {},
  };
}

export class PgLogRepo implements LogRepo {
  private readonly writer: PgLogWriter;

  constructor(private readonly q: Queryable) {
    this.writer = new PgLogWriter(q);
  }

  /** Shared INSERT path for API and worker log emitters. */
  insertMany(rows: readonly LogEventRecord[]): Promise<void> {
    return this.writer.insertMany(rows);
  }

  async query(opts: LogQuery): Promise<LogPage> {
    const where: string[] = [];
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (opts.level) where.push(`level = ${bind(opts.level)}`);
    if (opts.service) where.push(`service = ${bind(opts.service)}`);
    if (opts.since) where.push(`ts >= ${bind(opts.since)}`);
    if (opts.q) where.push(`message ILIKE ${bind(`%${escapeLike(opts.q)}%`)} ESCAPE '\\'`);

    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    if (cursor) {
      // Row-value comparison keeps pagination stable when timestamps tie.
      where.push(`(ts, id) < (${bind(cursor.ts)}, ${bind(cursor.id)})`);
    }

    // Over-fetch by one to learn whether another page exists, without a second COUNT query.
    const { rows } = await this.q.query(
      `SELECT id, ts, level, service, message, stack, request_id, run_id, conversation_id, attributes
       FROM log_event
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ts DESC, id DESC
       LIMIT ${bind(opts.limit + 1)}`,
      params
    );

    const hasMore = rows.length > opts.limit;
    const items = (hasMore ? rows.slice(0, opts.limit) : rows).map(toView);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.ts, last.id) : null,
    };
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    // `RETURNING id` works across pg and PGlite Queryable, which exposes only `rows`.
    const res = await this.q.query("DELETE FROM log_event WHERE ts < $1 RETURNING id", [cutoff]);
    return res.rows.length;
  }
}
