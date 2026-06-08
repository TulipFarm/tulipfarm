import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPgMigrations } from "./pg-migrate";
import { PgRateLimiter } from "./rate-limit";
import { makePglite } from "./test/pglite";

describe("PgRateLimiter (fixed-window)", () => {
  let db: PGlite;
  let limiter: PgRateLimiter;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    limiter = new PgRateLimiter(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("allows up to the limit, then denies", async () => {
    const r1 = await limiter.check("k", 2, 60000);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(1);
    const r2 = await limiter.check("k", 2, 60000);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);
    const r3 = await limiter.check("k", 2, 60000);
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
  });

  it("isolates counts by key", async () => {
    await limiter.check("a", 1, 60000);
    expect((await limiter.check("b", 1, 60000)).allowed).toBe(true);
  });

  it("resetAt is aligned to the fixed window boundary", async () => {
    const r = await limiter.check("k", 5, 60000);
    expect(r.resetAt % 60000).toBe(0);
  });

  it("starts a fresh count in the next window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(0);
      const win = 1000;
      expect((await limiter.check("w", 1, win)).allowed).toBe(true);
      expect((await limiter.check("w", 1, win)).allowed).toBe(false);
      vi.setSystemTime(win);
      expect((await limiter.check("w", 1, win)).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
