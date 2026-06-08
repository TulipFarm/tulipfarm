import { randomBytes } from "node:crypto";
import type { Queryable } from "../db";

export interface SessionStore {
  create(userId: string): Promise<string>;
  get(sid: string): Promise<string | null>;
  destroy(sid: string): Promise<void>;
}

/** Default session lifetime: 7 days (seconds). Override via SESSION_TTL_SECONDS. */
export const DEFAULT_SESSION_TTL_SECONDS = 604800;

// 32 random bytes → 43-char base64url string (no padding). Unguessable session id.
function newSid(): string {
  return randomBytes(32).toString("base64url");
}

// In-memory store for tests; ignores TTL. Not for production use.
export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, string>();

  async create(userId: string): Promise<string> {
    const sid = newSid();
    this.sessions.set(sid, userId);
    return sid;
  }

  async get(sid: string): Promise<string | null> {
    return this.sessions.get(sid) ?? null;
  }

  async destroy(sid: string): Promise<void> {
    this.sessions.delete(sid);
  }
}

// Production store backed by Postgres (the `sessions` table) with a configurable TTL (seconds).
export class PgSessionStore implements SessionStore {
  constructor(
    private readonly q: Queryable,
    private readonly ttlSeconds: number
  ) {}

  async create(userId: string): Promise<string> {
    const sid = newSid();
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    await this.q.query("INSERT INTO sessions (sid, user_id, expires_at) VALUES ($1, $2, $3)", [
      sid,
      userId,
      expiresAt,
    ]);
    return sid;
  }

  async get(sid: string): Promise<string | null> {
    const { rows } = await this.q.query(
      "SELECT user_id FROM sessions WHERE sid = $1 AND expires_at > now()",
      [sid]
    );
    return rows.length > 0 ? (rows[0] as { user_id: string }).user_id : null;
  }

  async destroy(sid: string): Promise<void> {
    await this.q.query("DELETE FROM sessions WHERE sid = $1", [sid]);
  }
}
