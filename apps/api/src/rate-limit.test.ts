import { describe, expect, it } from "vitest";
import { MemoryRateLimiter } from "./rate-limit";

describe("MemoryRateLimiter", () => {
  it("allows requests under the limit", async () => {
    const limiter = new MemoryRateLimiter();
    const result = await limiter.check("test-key", 3, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(3);
    expect(result.remaining).toBe(2);
  });

  it("allows up to limit then denies", async () => {
    const limiter = new MemoryRateLimiter();
    for (let i = 0; i < 3; i++) {
      const r = await limiter.check("key", 3, 60_000);
      expect(r.allowed).toBe(true);
    }
    const denied = await limiter.check("key", 3, 60_000);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("remaining decrements correctly", async () => {
    const limiter = new MemoryRateLimiter();
    const r1 = await limiter.check("key", 5, 60_000);
    expect(r1.remaining).toBe(4);
    const r2 = await limiter.check("key", 5, 60_000);
    expect(r2.remaining).toBe(3);
  });

  it("keys are independent", async () => {
    const limiter = new MemoryRateLimiter();
    await limiter.check("a", 1, 60_000);
    const denied = await limiter.check("a", 1, 60_000);
    expect(denied.allowed).toBe(false);

    const other = await limiter.check("b", 1, 60_000);
    expect(other.allowed).toBe(true);
  });

  it("resetAt is in the future on deny", async () => {
    const limiter = new MemoryRateLimiter();
    const before = Date.now();
    await limiter.check("key", 1, 60_000);
    const result = await limiter.check("key", 1, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.resetAt).toBeGreaterThan(before);
  });

  it("expired entries do not count toward limit", async () => {
    const limiter = new MemoryRateLimiter();
    // Use a 1ms window — any check after will see the old entry as expired
    await limiter.check("key", 1, 1);
    await new Promise((r) => setTimeout(r, 5));
    const result = await limiter.check("key", 1, 1);
    expect(result.allowed).toBe(true);
  });

  it("limit and windowMs are per-call (not shared state)", async () => {
    const limiter = new MemoryRateLimiter();
    const r = await limiter.check("k", 10, 60_000);
    expect(r.limit).toBe(10);
    expect(r.remaining).toBe(9);
  });
});
