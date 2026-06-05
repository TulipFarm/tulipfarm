import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // Unix ms
}

export interface RateLimiter {
  check(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

// Lua script: atomic sliding window via ZSET.
// Returns [allowed(0|1), limit, remaining, resetAt(ms)]
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
local clearBefore = now - windowMs

redis.call('ZREMRANGEBYSCORE', key, '-inf', clearBefore - 1)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, windowMs)
  return {1, limit, limit - count - 1, now + windowMs}
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetAt = tonumber(oldest[2]) + windowMs
  return {0, limit, 0, resetAt}
end
`.trim();

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly log: { warn: (msg: string) => void }
  ) {}

  async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    try {
      const member = randomBytes(8).toString("hex");
      const now = Date.now();
      const result = (await this.redis.eval(
        SLIDING_WINDOW_SCRIPT,
        1,
        key,
        String(now),
        String(windowMs),
        String(limit),
        member
      )) as [number, number, number, number];
      return {
        allowed: result[0] === 1,
        limit: result[1],
        remaining: result[2],
        resetAt: result[3],
      };
    } catch {
      this.log.warn("rate-limit: Redis unavailable, allowing request");
      return { allowed: true, limit, remaining: limit, resetAt: Date.now() + windowMs };
    }
  }
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
