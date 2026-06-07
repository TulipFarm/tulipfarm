import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

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

const KEY_PREFIX = "sess:";

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

// Production store backed by Redis with a configurable TTL (seconds).
export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number
  ) {}

  async create(userId: string): Promise<string> {
    const sid = newSid();
    await this.redis.set(`${KEY_PREFIX}${sid}`, userId, "EX", this.ttlSeconds);
    return sid;
  }

  get(sid: string): Promise<string | null> {
    return this.redis.get(`${KEY_PREFIX}${sid}`);
  }

  async destroy(sid: string): Promise<void> {
    await this.redis.del(`${KEY_PREFIX}${sid}`);
  }
}
