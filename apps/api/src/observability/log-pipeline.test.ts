import type { PGlite } from "@electric-sql/pglite";
import { BatchingLogSink } from "@tulipfarm/observability";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildApp } from "../app";
import { makeMigratedPglite } from "../test/pglite";
import { PgLogRepo } from "./log-repo";

/** Assembled Fastify-to-log_event test for wiring bugs that unit tests of each hop cannot catch. */

let app: FastifyInstance;
let db: PGlite;
let sink: BatchingLogSink;

beforeEach(async () => {
  db = await makeMigratedPglite();
  const repo = new PgLogRepo(db);
  sink = new BatchingLogSink({
    service: "api",
    writer: repo,
    // Flushed by hand below; a live timer would race the assertion.
    schedule: () => () => {},
  });
  app = await buildApp({ logSink: sink, logRepo: repo });
  app.get("/boom", async () => {
    throw new Error("kaboom from the route");
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await db.close();
});

it("persists a thrown route error, with its stack and request id, through the real logger", async () => {
  const res = await app.inject({ method: "GET", url: "/boom" });
  expect(res.statusCode).toBe(500);

  await sink.flush();

  const rows = await new PgLogRepo(db).query({ limit: 10 });
  const record = rows.items.find((r) => r.message.includes("kaboom from the route"));
  expect(record).toBeDefined();
  expect(record?.level).toBe("error");
  expect(record?.service).toBe("api");
  // The stack is the reason this feature exists — a message alone would not locate the failure.
  expect(record?.stack).toContain("kaboom from the route");
  // Correlates the record back to the request that produced it.
  expect(record?.requestId).toBeTruthy();
});

it("leaves non-error request logging out of the table", async () => {
  await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
  await sink.flush();

  const rows = await new PgLogRepo(db).query({ limit: 10 });
  expect(rows.items).toHaveLength(0);
});
