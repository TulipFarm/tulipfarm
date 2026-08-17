import { PGlite } from "@electric-sql/pglite";
import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import {
  CURATOR_ADMISSION_STATEMENTS,
  CURATOR_STORAGE_STATEMENTS,
  CURATOR_WORK_STORAGE_STATEMENTS,
  CuratorAdmissionLedger,
  CuratorMintStore,
  CuratorRepo,
  type Queryable,
  recordCuratorWork,
  TASK_STORAGE_STATEMENTS,
} from "@tulipfarm/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CuratorMinter } from "./mint";

const BUSINESS = "business-1";
const USER = "user-1";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const LIMITS = {
  workLimit: 50,
  candidateLimit: 50,
  runCostMicros: 50_000,
  dailyCapMicros: 5_000_000,
};

interface StartCall {
  runSource: string;
  businessId: string;
  initiator: { kind: string; id: string };
  effectiveSubject: { kind: string; id: string };
  idempotencyKey: string;
  identityMappingEvidenceRef?: string;
  payload: Record<string, unknown>;
}

describe("CuratorMinter", () => {
  let database: PGlite;
  let pool: Queryable;
  let repo: CuratorRepo;
  let admission: CuratorAdmissionLedger;
  let store: CuratorMintStore;
  let starts: StartCall[];
  let providerAvailable: boolean;
  let minter: CuratorMinter;
  let startFails: boolean;

  const gateway = (): DurableInvocationGateway =>
    ({
      start: async (input: StartCall) => {
        if (startFails) throw new Error("gateway down");
        starts.push(input);
        return { runId: `run-${starts.length}`, outcome: "started" as const };
      },
    }) as unknown as DurableInvocationGateway;

  const work = async (sourceKey: string, minute = 0, userId = USER) =>
    recordCuratorWork(
      pool,
      { businessId: BUSINESS, userId, reason: "turn_completed", sourceKey },
      new Date(Date.UTC(2026, 0, 1, 0, minute))
    );

  const CANDIDATE_IDS: Record<string, string> = {
    "cand-1": "aaaaaaaa-1111-4111-8111-111111111111",
    "cand-2": "bbbbbbbb-2222-4222-8222-222222222222",
  };

  const candidate = async (name: string) =>
    pool.query(
      `INSERT INTO curator_candidate (id, business_id, direction, payload)
       VALUES ($1, $2, 'knowledge_promotion', $3)`,
      [CANDIDATE_IDS[name], BUSINESS, JSON.stringify({ statement: "Acme ships weekly" })]
    );

  const statuses = async (): Promise<string[]> =>
    (
      await pool.query<{ status: string }>(
        "SELECT status FROM curator_user_work ORDER BY source_key"
      )
    ).rows.map((row) => row.status);

  beforeAll(async () => {
    database = new PGlite();
    pool = database as unknown as Queryable;
    for (const statement of [
      ...TASK_STORAGE_STATEMENTS,
      ...CURATOR_WORK_STORAGE_STATEMENTS,
      ...CURATOR_STORAGE_STATEMENTS,
      ...CURATOR_ADMISSION_STATEMENTS,
    ])
      await database.exec(statement);
    repo = new CuratorRepo(pool);
    admission = new CuratorAdmissionLedger(pool);
    store = new CuratorMintStore(pool, repo, admission, LIMITS);
  });

  afterAll(async () => await database.close());

  beforeEach(async () => {
    await database.exec(
      `DELETE FROM curator_user_work; DELETE FROM curator_candidate;
       DELETE FROM curator_job; DELETE FROM curator_admission`
    );
    starts = [];
    providerAvailable = true;
    startFails = false;
    minter = new CuratorMinter({
      store,
      repo,
      pool,
      invocations: gateway(),
      providerAvailable: async () => providerAvailable,
      soulDigest: () => "a".repeat(64),
      now: () => NOW,
    });
  });

  describe("mintForUser", () => {
    it("skips without a provider, before claiming anything", async () => {
      await work("turn-1");
      providerAvailable = false;
      expect(await minter.mintForUser(BUSINESS, USER)).toEqual({
        outcome: "skipped",
        reason: "no_provider",
      });
      expect(await statuses()).toEqual(["due"]);
    });

    it("skips a user with no due work", async () => {
      expect(await minter.mintForUser(BUSINESS, USER)).toEqual({
        outcome: "skipped",
        reason: "no_work",
      });
      expect(starts).toEqual([]);
    });

    it("mints a Run over the work it claimed", async () => {
      await work("turn-1");
      const result = await minter.mintForUser(BUSINESS, USER);
      expect(result).toMatchObject({ outcome: "minted", runId: "run-1" });
      expect(await statuses()).toEqual(["claimed"]);
    });

    it("attributes the Run to the Curator while acting as the user", async () => {
      await work("turn-1");
      await minter.mintForUser(BUSINESS, USER);
      expect(starts[0]).toMatchObject({
        runSource: "curator",
        initiator: { kind: "service", id: "curator" },
        effectiveSubject: { kind: "user", id: USER },
      });
    });

    it("keys idempotency and substitution evidence to the job, not the target", async () => {
      await work("turn-1");
      const minted = await minter.mintForUser(BUSINESS, USER);
      const jobId = minted.outcome === "minted" ? minted.jobId : "";
      expect(starts[0]?.idempotencyKey).toBe(`curator-job-v1:${jobId}`);
      expect(starts[0]?.identityMappingEvidenceRef).toBe(`curator-job:${jobId}`);
    });

    it("sends references only — never a transcript", async () => {
      await work("turn-1");
      await minter.mintForUser(BUSINESS, USER);
      expect(starts[0]?.payload).toEqual({
        jobId: expect.any(String),
        scope: "user",
        subjectUserId: USER,
        reasons: ["turn_completed"],
        turnIds: ["turn-1"],
        inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    });

    it("binds the Run to the job", async () => {
      await work("turn-1");
      const minted = await minter.mintForUser(BUSINESS, USER);
      const jobId = minted.outcome === "minted" ? minted.jobId : "";
      expect((await repo.getJob(BUSINESS, jobId))?.runId).toBe("run-1");
    });

    it("mints shadow, so nothing built in this slice can apply an effect", async () => {
      await work("turn-1");
      const minted = await minter.mintForUser(BUSINESS, USER);
      const jobId = minted.outcome === "minted" ? minted.jobId : "";
      expect((await repo.getJob(BUSINESS, jobId))?.executionMode).toBe("shadow");
    });

    it("refuses a second Run for a user who already has a live one, losing no work", async () => {
      await work("turn-1", 0);
      await minter.mintForUser(BUSINESS, USER);
      await work("turn-2", 5);
      expect(await minter.mintForUser(BUSINESS, USER)).toEqual({
        outcome: "skipped",
        reason: "target_busy",
      });
      expect(await statuses()).toEqual(["claimed", "due"]);
    });

    it("still mints for a different user", async () => {
      await work("turn-1");
      await work("turn-2", 0, "user-2");
      await minter.mintForUser(BUSINESS, USER);
      expect(await minter.mintForUser(BUSINESS, "user-2")).toMatchObject({ outcome: "minted" });
    });

    it("caps how much work one Run reasons over", async () => {
      for (let index = 0; index <= LIMITS.workLimit; index += 1) await work(`turn-${index}`, index);
      await minter.mintForUser(BUSINESS, USER);
      expect((await statuses()).filter((status) => status === "claimed")).toHaveLength(
        LIMITS.workLimit
      );
    });

    it("refuses once the day's reservations would exceed the ceiling, and returns the claim", async () => {
      await pool.query(
        "INSERT INTO curator_admission (business_id, day, reserved_cost_micros) VALUES ($1, $2, $3)",
        [BUSINESS, "2026-01-01", LIMITS.dailyCapMicros - LIMITS.runCostMicros + 1]
      );
      await work("turn-1");
      expect(await minter.mintForUser(BUSINESS, USER)).toEqual({
        outcome: "skipped",
        reason: "budget_exhausted",
      });
      expect(await statuses()).toEqual(["due"]);
    });

    it("charges the reservation once per minted Run", async () => {
      await work("turn-1");
      await minter.mintForUser(BUSINESS, USER);
      const { rows } = await pool.query<{ reserved_cost_micros: string }>(
        "SELECT reserved_cost_micros FROM curator_admission WHERE business_id = $1",
        [BUSINESS]
      );
      expect(Number(rows[0]?.reserved_cost_micros)).toBe(LIMITS.runCostMicros);
    });

    it("leaves the job recoverable when the Run never started", async () => {
      await work("turn-1");
      startFails = true;
      await expect(minter.mintForUser(BUSINESS, USER)).rejects.toThrow("gateway down");
      const { rows } = await pool.query<{ run_id: string | null; state: string }>(
        "SELECT run_id, state FROM curator_job"
      );
      expect(rows[0]).toMatchObject({ run_id: null, state: "minted" });
    });
  });

  describe("mintForBusiness", () => {
    it("skips when no candidate is waiting", async () => {
      expect(await minter.mintForBusiness(BUSINESS)).toEqual({
        outcome: "skipped",
        reason: "no_work",
      });
    });

    it("pins the candidates it reasons over and names no audience", async () => {
      await candidate("cand-1");
      await minter.mintForBusiness(BUSINESS);
      expect(starts[0]?.payload).toEqual({
        jobId: expect.any(String),
        scope: "business",
        soulDigest: "a".repeat(64),
        candidateIds: [CANDIDATE_IDS["cand-1"]],
        inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(starts[0]?.effectiveSubject).toEqual({ kind: "service", id: "curator" });
    });

    it("refuses a second business Run while one is live", async () => {
      await candidate("cand-1");
      await minter.mintForBusiness(BUSINESS);
      await candidate("cand-2");
      expect(await minter.mintForBusiness(BUSINESS)).toEqual({
        outcome: "skipped",
        reason: "target_busy",
      });
    });

    it("does not block a user Run for the same business", async () => {
      await candidate("cand-1");
      await work("turn-1");
      await minter.mintForBusiness(BUSINESS);
      expect(await minter.mintForUser(BUSINESS, USER)).toMatchObject({ outcome: "minted" });
    });
  });

  describe("abandon", () => {
    it("returns the work and frees the day's budget", async () => {
      await work("turn-1");
      const minted = await minter.mintForUser(BUSINESS, USER);
      const jobId = minted.outcome === "minted" ? minted.jobId : "";
      await minter.abandon(jobId);
      expect(await statuses()).toEqual(["due"]);
      const { rows } = await pool.query<{ reserved_cost_micros: string }>(
        "SELECT reserved_cost_micros FROM curator_admission WHERE business_id = $1",
        [BUSINESS]
      );
      expect(Number(rows[0]?.reserved_cost_micros)).toBe(0);
    });

    it("is safe to repeat", async () => {
      await work("turn-1");
      const minted = await minter.mintForUser(BUSINESS, USER);
      const jobId = minted.outcome === "minted" ? minted.jobId : "";
      await minter.abandon(jobId);
      await expect(minter.abandon(jobId)).resolves.toBeUndefined();
    });
  });
});
