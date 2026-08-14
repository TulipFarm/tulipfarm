import type { FastifyReply, FastifyRequest } from "fastify";
import type { Queryable } from "./db";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // Unix ms
}

export interface RateLimiter {
  check(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, number[]>();

  async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const clearBefore = now - windowMs;

    const timestamps = (this.windows.get(key) ?? []).filter((t) => t > clearBefore);

    if (timestamps.length < limit) {
      timestamps.push(now);
      this.windows.set(key, timestamps);
      return {
        allowed: true,
        limit,
        remaining: limit - timestamps.length,
        resetAt: now + windowMs,
      };
    }

    const resetAt = timestamps[0] + windowMs;
    this.windows.set(key, timestamps);
    return { allowed: false, limit, remaining: 0, resetAt };
  }
}

/** Postgres fixed-window limiter: one row per (key, window). */
export class PgRateLimiter implements RateLimiter {
  constructor(private readonly q: Queryable) {}

  async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStartMs = Math.floor(now / windowMs) * windowMs;
    const resetAt = windowStartMs + windowMs;
    try {
      const { rows } = await this.q.query(
        `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
         ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
         RETURNING count`,
        [key, new Date(windowStartMs)]
      );
      const count = Number((rows[0] as { count: number }).count);
      return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetAt };
    } catch {
      // Fail-open if Postgres is unavailable (availability over strict enforcement).
      return { allowed: true, limit, remaining: limit, resetAt };
    }
  }
}

export function makeRateLimitHook(
  limiter: RateLimiter,
  getKey: (req: FastifyRequest) => string,
  limit: number,
  windowMs: number
) {
  return async function rateLimitHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const result = await limiter.check(getKey(req), limit, windowMs);

    reply.header("X-RateLimit-Limit", String(result.limit));
    reply.header("X-RateLimit-Remaining", String(result.remaining));
    reply.header("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));

    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
      reply.header("Retry-After", String(Math.max(retryAfter, 1)));
      reply.code(429).send({ error: "rate_limit_exceeded" });
    }
  };
}
