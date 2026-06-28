import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { OBS_RETENTION_MS } from "./prune";
import { PgObsRepo } from "./repo";
import { ObservabilityService } from "./service";

const DAY = 24 * 60 * 60 * 1000;

describe("obs_event prune (deleteOlderThan)", () => {
  let db: PGlite;
  let repo: PgObsRepo;
  let service: ObservabilityService;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    repo = new PgObsRepo(db);
    service = new ObservabilityService(repo);
  });

  afterEach(async () => {
    await db.close();
  });

  it("deletes rows older than the retention window, keeps recent ones", async () => {
    await service.record({ type: "llm_call", ts: new Date(Date.now() - 100 * DAY), status: "ok" });
    await service.record({ type: "llm_call", ts: new Date(Date.now() - 1 * DAY), status: "ok" });

    const deleted = await repo.deleteOlderThan(new Date(Date.now() - OBS_RETENTION_MS));
    expect(deleted).toBe(1);

    const { rows } = await db.query("SELECT count(*)::int AS n FROM obs_event");
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});
