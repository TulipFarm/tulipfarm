import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgCounterStore } from "./repo";

describe("PgCounterStore", () => {
  let db: PGlite;
  let next: (type: string) => Promise<number>;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    next = new PgCounterStore(db).makeCounterFn();
  });

  afterEach(async () => {
    await db.close();
  });

  it("returns a monotonically increasing sequence per type (ON CONFLICT upsert)", async () => {
    expect(await next("ticket")).toBe(1);
    expect(await next("ticket")).toBe(2);
    expect(await next("ticket")).toBe(3);
  });

  it("keeps a separate sequence per type", async () => {
    expect(await next("ticket")).toBe(1);
    expect(await next("invoice")).toBe(1);
    expect(await next("ticket")).toBe(2);
    expect(await next("invoice")).toBe(2);
  });
});
