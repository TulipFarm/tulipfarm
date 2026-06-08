import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgStreamResumeRepo } from "./stream-resume";

describe("PgStreamResumeRepo", () => {
  let db: PGlite;
  let repo: PgStreamResumeRepo;
  let streamId: string;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new PgStreamResumeRepo(db);
    streamId = randomUUID();
  });

  afterEach(async () => {
    await db.close();
  });

  const append = (seq: number, eventType = "text", data: unknown = { delta: `d${seq}` }) =>
    repo.append({ streamId, seq, eventType, data, createdAt: new Date() });

  it("appends events and lists them after a cursor in seq order", async () => {
    await append(1);
    await append(2);
    await append(3, "finish", { reason: "stop" });

    const all = await repo.listAfter(streamId, 0);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(all[0]).toEqual({ seq: 1, eventType: "text", data: { delta: "d1" } });
    expect(all[2].eventType).toBe("finish");

    const tail = await repo.listAfter(streamId, 1);
    expect(tail.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("returns an empty tail past the last seq", async () => {
    await append(1);
    expect(await repo.listAfter(streamId, 5)).toEqual([]);
  });

  it("scopes events by stream id", async () => {
    await append(1);
    const other = new PgStreamResumeRepo(db);
    await other.append({
      streamId: randomUUID(),
      seq: 1,
      eventType: "text",
      data: {},
      createdAt: new Date(),
    });
    expect(await repo.listAfter(streamId, 0)).toHaveLength(1);
  });

  it("is idempotent on (stream_id, seq)", async () => {
    await append(1, "text", { delta: "first" });
    await append(1, "text", { delta: "second" });
    const rows = await repo.listAfter(streamId, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toEqual({ delta: "first" });
  });

  it("deleteOlderThan removes only rows before the cutoff", async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await repo.append({ streamId, seq: 1, eventType: "text", data: {}, createdAt: old });
    await repo.append({ streamId, seq: 2, eventType: "text", data: {}, createdAt: new Date() });

    const removed = await repo.deleteOlderThan(new Date(Date.now() - 60 * 60 * 1000));
    expect(removed).toBe(1);
    const remaining = await repo.listAfter(streamId, 0);
    expect(remaining.map((e) => e.seq)).toEqual([2]);
  });
});
