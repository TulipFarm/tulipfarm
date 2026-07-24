import { randomBytes } from "node:crypto";
import type { Queryable } from "../db";

/**
 * Authentication methods a session can carry (SPEC §12: local credentials and OIDC, with
 * passkeys/MFA where the identity provider supports them). Recorded per session so step-up
 * checks can require a specific method rather than trusting an opaque "logged in" bit.
 */
export type AuthMethod = "password" | "oidc" | "totp" | "passkey";

export interface SessionRecord {
  readonly sid: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly authMethods: readonly AuthMethod[];
  /** When a second factor was last proven for this session; null when only a first factor ran. */
  readonly mfaVerifiedAt: Date | null;
  /** Session-bound CSRF token — a double-submit token alone is not accepted (see csrf.ts). */
  readonly csrfToken: string;
}

export interface SessionInit {
  readonly userId: string;
  readonly authMethods: readonly AuthMethod[];
  readonly mfaVerifiedAt?: Date | null;
}

export interface SessionStore {
  /** Issue a new session, recording how the principal authenticated. */
  issue(init: SessionInit): Promise<SessionRecord>;
  /** Read a live session; returns null when unknown or expired. */
  read(sid: string): Promise<SessionRecord | null>;
  /**
   * Legacy shim: a session with no bound CSRF token, which falls back to plain double-submit
   * CSRF (see csrf.ts). Product code must use `issue` so the token dies with the session.
   */
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

function newCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Issue a replacement session for `oldSid` and destroy the old one. Every authentication and
 * privilege elevation rotates the identifier so a session id observed before the elevation can
 * never be replayed against the elevated session (SPEC §24 session fixation).
 */
export async function rotateSession(
  store: SessionStore,
  oldSid: string | undefined,
  init: SessionInit
): Promise<SessionRecord> {
  const record = await store.issue(init);
  if (oldSid && oldSid !== record.sid) {
    await store.destroy(oldSid);
  }
  return record;
}

// In-memory store for tests; ignores TTL. Not for production use.
export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionRecord>();

  async issue(init: SessionInit): Promise<SessionRecord> {
    const now = new Date();
    const record: SessionRecord = {
      sid: newSid(),
      userId: init.userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + DEFAULT_SESSION_TTL_SECONDS * 1000),
      authMethods: [...init.authMethods],
      mfaVerifiedAt: init.mfaVerifiedAt ?? null,
      csrfToken: newCsrfToken(),
    };
    this.sessions.set(record.sid, record);
    return record;
  }

  async read(sid: string): Promise<SessionRecord | null> {
    const record = this.sessions.get(sid);
    if (!record) return null;
    if (record.expiresAt <= new Date()) return null;
    return record;
  }

  async create(userId: string): Promise<string> {
    const record = await this.issue({ userId, authMethods: ["password"] });
    this.sessions.set(record.sid, { ...record, csrfToken: "" });
    return record.sid;
  }

  async get(sid: string): Promise<string | null> {
    return (await this.read(sid))?.userId ?? null;
  }

  async destroy(sid: string): Promise<void> {
    this.sessions.delete(sid);
  }
}

function rowToSession(row: Record<string, unknown>): SessionRecord {
  return {
    sid: row.sid as string,
    userId: row.user_id as string,
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
    authMethods: (row.auth_methods as AuthMethod[] | null) ?? [],
    mfaVerifiedAt: (row.mfa_verified_at as Date | null) ?? null,
    csrfToken: (row.csrf_token as string | null) ?? "",
  };
}

// Production store backed by Postgres (the `sessions` table) with a configurable TTL (seconds).
export class PgSessionStore implements SessionStore {
  constructor(
    private readonly q: Queryable,
    private readonly ttlSeconds: number
  ) {}

  async issue(init: SessionInit): Promise<SessionRecord> {
    const now = new Date();
    const record: SessionRecord = {
      sid: newSid(),
      userId: init.userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000),
      authMethods: [...init.authMethods],
      mfaVerifiedAt: init.mfaVerifiedAt ?? null,
      csrfToken: newCsrfToken(),
    };
    await this.q.query(
      `INSERT INTO sessions (sid, user_id, created_at, expires_at, auth_methods, mfa_verified_at, csrf_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        record.sid,
        record.userId,
        record.createdAt,
        record.expiresAt,
        record.authMethods,
        record.mfaVerifiedAt,
        record.csrfToken,
      ]
    );
    return record;
  }

  async read(sid: string): Promise<SessionRecord | null> {
    const { rows } = await this.q.query(
      "SELECT * FROM sessions WHERE sid = $1 AND expires_at > now()",
      [sid]
    );
    return rows.length > 0 ? rowToSession(rows[0]) : null;
  }

  async create(userId: string): Promise<string> {
    const record = await this.issue({ userId, authMethods: ["password"] });
    await this.q.query("UPDATE sessions SET csrf_token = NULL WHERE sid = $1", [record.sid]);
    return record.sid;
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
