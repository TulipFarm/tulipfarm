import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../ports";
import { TASK_STORAGE_STATEMENTS } from "../tasks/task-repo";
import { CURATOR_ADMISSION_STATEMENTS, CuratorAdmissionLedger } from "./admission";
import { type CuratorJobRecord, CuratorRepo } from "./repo";
import { CURATOR_STORAGE_STATEMENTS } from "./schema";

const BUSINESS = "business-1";
const DAY = "2026-01-01";

describe("CuratorAdmissionLedger (PostgreSQL)", () => {
  let database: PGlite;
  let repo: CuratorRepo;
  let ledger: CuratorAdmissionLedger;

  const seedJob = async (overrides: Partial<CuratorJobRecord> = {}): Promise<CuratorJobRecord> => {
    const job = await repo.insertJob(database as unknown as Queryable, {
      businessId: BUSINESS,
      scope: "user",
      userId: "user-1",
      state: "minted",
      executionMode: "shadow",
      manifestDigest: "digest-1",
      manifest: { work: [], turnIds: [], candidateIds: [] },
      ...overrides,
    });
    if (!job) throw new Error("expected the job to mint");
    return job;
  };

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of [
      ...TASK_STORAGE_STATEMENTS,
      ...CURATOR_STORAGE_STATEMENTS,
      ...CURATOR_ADMISSION_STATEMENTS,
    ]) {
      await database.exec(sql);
    }
    repo = new CuratorRepo(database as unknown as Queryable);
    ledger = new CuratorAdmissionLedger(database as unknown as Queryable);
  });

  afterAll(async () => await database.close());

  beforeEach(async () => {
    await database.exec("DELETE FROM curator_admission; DELETE FROM curator_job");
  });

  describe("admission", () => {
    const reserve = async (job: CuratorJobRecord, costMicros: number, dailyCapMicros: number) =>
      ledger.reserve(database as unknown as Queryable, {
        jobId: job.id,
        businessId: BUSINESS,
        day: DAY,
        costMicros,
        dailyCapMicros,
      });

    it("admits while the day can afford the reservation", async () => {
      const job = await seedJob();
      expect(await reserve(job, 400, 1000)).toBe(true);
      const { rows } = await database.query<{ reserved_cost_micros: string }>(
        "SELECT reserved_cost_micros FROM curator_admission"
      );
      expect(Number(rows[0]?.reserved_cost_micros)).toBe(400);
    });

    it("refuses a job larger than the whole cap, even on an empty day", async () => {
      const job = await seedJob();
      expect(await reserve(job, 1001, 1000)).toBe(false);
    });

    it("counts outstanding reservations against later ones", async () => {
      const first = await seedJob();
      const second = await seedJob({ userId: "user-2" });
      expect(await reserve(first, 700, 1000)).toBe(true);
      expect(await reserve(second, 400, 1000)).toBe(false);
    });

    it("charges a replayed mint only once", async () => {
      const job = await seedJob();
      expect(await reserve(job, 400, 1000)).toBe(true);
      expect(await reserve(job, 400, 1000)).toBe(true);
      const { rows } = await database.query<{ reserved_cost_micros: string }>(
        "SELECT reserved_cost_micros FROM curator_admission"
      );
      expect(Number(rows[0]?.reserved_cost_micros)).toBe(400);
    });

    it("replaces the reservation with what the job actually spent", async () => {
      const job = await seedJob();
      await reserve(job, 700, 1000);
      expect(await ledger.settle(job.id, 120)).toBe(true);
      const { rows } = await database.query<{ reserved: string; actual: string }>(
        `SELECT reserved_cost_micros AS reserved, actual_cost_micros AS actual
           FROM curator_admission`
      );
      expect(Number(rows[0]?.reserved)).toBe(0);
      expect(Number(rows[0]?.actual)).toBe(120);
    });

    it("returns the whole reservation when the job spent nothing", async () => {
      const job = await seedJob();
      await reserve(job, 700, 1000);
      await ledger.settle(job.id, 0);
      const { rows } = await database.query<{ reserved: string; state: string }>(
        `SELECT a.reserved_cost_micros AS reserved, r.state
           FROM curator_admission a, curator_admission_reservation r`
      );
      expect(Number(rows[0]?.reserved)).toBe(0);
      expect(rows[0]?.state).toBe("released");
    });

    it("settles a reservation exactly once", async () => {
      const job = await seedJob();
      await reserve(job, 700, 1000);
      expect(await ledger.settle(job.id, 120)).toBe(true);
      expect(await ledger.settle(job.id, 500)).toBe(false);
      const { rows } = await database.query<{ actual: string }>(
        "SELECT actual_cost_micros AS actual FROM curator_admission"
      );
      expect(Number(rows[0]?.actual)).toBe(120);
    });

    it("frees the day once settled spend leaves room again", async () => {
      const first = await seedJob();
      await reserve(first, 700, 1000);
      await ledger.settle(first.id, 100);
      const second = await seedJob({ userId: "user-2" });
      expect(await reserve(second, 400, 1000)).toBe(true);
    });
  });
});
