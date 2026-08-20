import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../ports";
import { RUN_STORAGE_STATEMENTS } from "../runs/run-store";
import { TASK_STORAGE_STATEMENTS } from "../tasks/task-repo";
import { CURATOR_ADMISSION_STATEMENTS, CuratorAdmissionLedger } from "./admission";
import { abandonCuratorJob } from "./reconcile";
import { CuratorRepo } from "./repo";
import { CURATOR_STORAGE_STATEMENTS } from "./schema";
import { CURATOR_WORK_STORAGE_STATEMENTS, recordCuratorWork } from "./work";

const BUSINESS = "business-1";
const USER = "user-1";
const OLD = new Date("2026-01-01T00:00:00Z");
const NOW = new Date("2026-01-01T01:00:00Z");

describe("Curator reconciliation (PostgreSQL)", () => {
  let database: PGlite;
  let db: Queryable;
  let repo: CuratorRepo;
  let admission: CuratorAdmissionLedger;

  const mint = async (overrides: { userId?: string; createdAt?: Date } = {}): Promise<string> => {
    const job = await repo.insertJob(db, {
      businessId: BUSINESS,
      scope: "user",
      userId: overrides.userId ?? USER,
      state: "minted",
      executionMode: "shadow",
      manifestDigest: "digest",
      manifest: { work: [], turnIds: [], candidateIds: [] },
    });
    if (!job) throw new Error("mint refused");
    await database.query(`UPDATE curator_job SET created_at = $2 WHERE id = $1`, [
      job.id,
      overrides.createdAt ?? OLD,
    ]);
    return job.id;
  };

  const run = async (status: string): Promise<string> => {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO runs (id, business_id, source, bundle, identity, status, created_at)
       VALUES (gen_random_uuid(), $1, 'schedule', '{}'::jsonb, '{}'::jsonb, $2, now())
       RETURNING id`,
      [BUSINESS, status]
    );
    return rows[0]?.id ?? "";
  };

  const runStatus = async (runId: string): Promise<string | undefined> =>
    (await database.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [runId]))
      .rows[0]?.status;

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of [
      ...TASK_STORAGE_STATEMENTS,
      ...RUN_STORAGE_STATEMENTS,
      ...CURATOR_STORAGE_STATEMENTS,
      ...CURATOR_WORK_STORAGE_STATEMENTS,
      ...CURATOR_ADMISSION_STATEMENTS,
    ]) {
      await database.exec(sql);
    }
    db = database as unknown as Queryable;
    repo = new CuratorRepo(db);
    admission = new CuratorAdmissionLedger(db);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec(
      `DELETE FROM curator_user_work; DELETE FROM curator_admission_reservation;
       DELETE FROM curator_admission; DELETE FROM curator_job; DELETE FROM runs`
    );
  });

  describe("listStale", () => {
    it("reports a job that committed but never reached the gateway as unstarted", async () => {
      const jobId = await mint();
      const stale = await repo.listStale(BUSINESS, NOW, 10);
      expect(stale.map((entry) => [entry.job.id, entry.disposition])).toEqual([
        [jobId, "unstarted"],
      ]);
    });

    it("leaves a job alone until it is older than the grace window", async () => {
      await mint({ createdAt: NOW });
      expect(await repo.listStale(BUSINESS, OLD, 10)).toEqual([]);
    });

    it("leaves a job with a live Run alone, however old it is", async () => {
      const jobId = await mint();
      await repo.attachRun(jobId, await run("waiting"));
      expect(await repo.listStale(BUSINESS, NOW, 10)).toEqual([]);
    });

    it("reports a job whose Run reached a terminal state as abandoned", async () => {
      const jobId = await mint();
      await repo.attachRun(jobId, await run("failed"));
      const stale = await repo.listStale(BUSINESS, NOW, 10);
      expect(stale.map((entry) => entry.disposition)).toEqual(["abandoned"]);
      expect(stale[0]?.job.id).toBe(jobId);
    });

    it("reports a job whose Run was parked for reconciliation as abandoned", async () => {
      const jobId = await mint();
      await repo.attachRun(jobId, await run("needs_reconciliation"));
      const stale = await repo.listStale(BUSINESS, NOW, 10);
      expect(stale.map((entry) => entry.disposition)).toEqual(["abandoned"]);
      expect(stale[0]?.job.id).toBe(jobId);
    });

    it("does not reach into another business", async () => {
      await mint();
      expect(await repo.listStale("business-2", NOW, 10)).toEqual([]);
    });
  });

  describe("abandonCuratorJob", () => {
    it("frees the target, the work and the reservation together", async () => {
      const jobId = await mint();
      await recordCuratorWork(
        db,
        { businessId: BUSINESS, userId: USER, reason: "turn_completed", sourceKey: "turn-1" },
        OLD
      );
      await database.query(
        `UPDATE curator_user_work SET status = 'claimed', job_id = $1 WHERE business_id = $2`,
        [jobId, BUSINESS]
      );
      await admission.reserve(db, {
        jobId,
        businessId: BUSINESS,
        day: "2026-01-01",
        costMicros: 500,
        dailyCapMicros: 10_000,
      });

      expect(await abandonCuratorJob(db, jobId)).toBe(true);

      expect((await repo.getJob(BUSINESS, jobId))?.state).toBe("cancelled");
      const work = await database.query<{ status: string }>(
        `SELECT status FROM curator_user_work WHERE business_id = $1`,
        [BUSINESS]
      );
      expect(work.rows[0]?.status).toBe("due");
      const held = await database.query<{ reserved_cost_micros: string }>(
        `SELECT reserved_cost_micros FROM curator_admission WHERE business_id = $1`,
        [BUSINESS]
      );
      expect(Number(held.rows[0]?.reserved_cost_micros)).toBe(0);
    });

    it("releases the target, so the next mint for that user is admitted", async () => {
      const jobId = await mint();
      await abandonCuratorJob(db, jobId);
      await expect(mint()).resolves.toBeTruthy();
    });

    it("refuses to requeue a job that already answered", async () => {
      const jobId = await mint();
      await database.query(`UPDATE curator_job SET output_digest = 'x' WHERE id = $1`, [jobId]);
      expect(await abandonCuratorJob(db, jobId)).toBe(false);
    });

    it("is idempotent, so a second reconciler pass changes nothing", async () => {
      const jobId = await mint();
      expect(await abandonCuratorJob(db, jobId)).toBe(true);
      expect(await abandonCuratorJob(db, jobId)).toBe(false);
    });

    it("closes the parked Run it gave up on", async () => {
      const jobId = await mint();
      const runId = await run("needs_reconciliation");
      await repo.attachRun(jobId, runId);

      expect(await abandonCuratorJob(db, jobId)).toBe(true);

      expect(await runStatus(runId)).toBe("failed");
    });

    it("leaves a Run the kernel already settled exactly as it found it", async () => {
      const jobId = await mint();
      const runId = await run("succeeded");
      await repo.attachRun(jobId, runId);

      expect(await abandonCuratorJob(db, jobId)).toBe(true);

      expect(await runStatus(runId)).toBe("succeeded");
    });
  });
});
