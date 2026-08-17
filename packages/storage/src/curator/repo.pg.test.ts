import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../ports";
import { TASK_STORAGE_STATEMENTS } from "../tasks/task-repo";
import { CURATOR_ADMISSION_STATEMENTS } from "./admission";
import { abandonCuratorJob } from "./reconcile";
import {
  type CuratorExecutionMode,
  type CuratorJobRecord,
  CuratorRepo,
  CuratorSettlementConflictError,
} from "./repo";
import { CURATOR_STORAGE_STATEMENTS } from "./schema";
import { CURATOR_WORK_STORAGE_STATEMENTS } from "./work";

const BUSINESS = "business-1";
const OTHER_BUSINESS = "business-2";

describe("CuratorRepo (PostgreSQL)", () => {
  let database: PGlite;
  let repo: CuratorRepo;

  const mint = async (
    overrides: Partial<CuratorJobRecord> = {}
  ): Promise<CuratorJobRecord | undefined> =>
    repo.insertJob(database as unknown as Queryable, {
      businessId: BUSINESS,
      scope: "user",
      userId: "user-1",
      state: "minted",
      executionMode: "apply",
      manifestDigest: "digest-1",
      manifest: { work: [], turnIds: [], candidateIds: [] },
      ...overrides,
    });

  const seedJob = async (overrides: Partial<CuratorJobRecord> = {}): Promise<CuratorJobRecord> => {
    const job = await mint(overrides);
    if (!job) throw new Error("expected the job to mint");
    return job;
  };

  const settle = async (
    job: CuratorJobRecord,
    effects: readonly { kind: string; payload: unknown }[] = [],
    rejections: readonly { effect: string; reason: string; detail?: string }[] = [],
    outputDigest = "output-1"
  ) =>
    repo.settle({
      job,
      outputDigest,
      generation: 1,
      effects: effects as Parameters<CuratorRepo["settle"]>[0]["effects"],
      rejections,
    });

  const candidate = async (direction: string, state: string, payload: unknown): Promise<string> => {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO curator_candidate (id, business_id, direction, payload, state)
       VALUES (gen_random_uuid(), $1, $2, $3::jsonb, $4) RETURNING id`,
      [BUSINESS, direction, JSON.stringify(payload), state]
    );
    return rows[0]?.id ?? "";
  };

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of [
      ...TASK_STORAGE_STATEMENTS,
      ...CURATOR_STORAGE_STATEMENTS,
      ...CURATOR_WORK_STORAGE_STATEMENTS,
      ...CURATOR_ADMISSION_STATEMENTS,
    ]) {
      await database.exec(sql);
    }
    repo = new CuratorRepo(database as unknown as Queryable);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("DELETE FROM curator_candidate; DELETE FROM curator_job");
  });

  describe("pinContext", () => {
    const PIN = {
      memoryRevisionId: "rev-1",
      sectionHashes: { identity: "a" },
      candidateDigest: "c",
      seedDigest: "s",
      soulDigest: null,
    };

    it("stores what a job's context resolved to", async () => {
      const created = await seedJob();
      expect(await repo.pinContext(created.id, PIN)).toEqual(PIN);
      expect((await repo.getJob(BUSINESS, created.id))?.contextPin).toEqual(PIN);
    });

    it("keeps the first pin and reports it, so a later resolution cannot rewrite history", async () => {
      const created = await seedJob();
      await repo.pinContext(created.id, PIN);
      const second = await repo.pinContext(created.id, { ...PIN, memoryRevisionId: "rev-2" });
      expect(second).toEqual(PIN);
    });
  });

  describe("minting", () => {
    it("reads back a job it minted", async () => {
      const created = await seedJob({ manifest: { work: [], turnIds: ["t1"], candidateIds: [] } });
      const found = await repo.getJob(BUSINESS, created.id);
      expect(found?.manifest.turnIds).toEqual(["t1"]);
      expect(found?.executionMode).toBe("apply");
      expect(found?.outputDigest).toBeUndefined();
    });

    it("does not leak a job across businesses", async () => {
      const created = await seedJob();
      expect(await repo.getJob(OTHER_BUSINESS, created.id)).toBeUndefined();
    });

    it("rejects a user job with no user and a business job with one", async () => {
      await expect(mint({ scope: "user", userId: undefined })).rejects.toThrow();
      await expect(mint({ scope: "business", userId: "user-1" })).rejects.toThrow();
    });

    it("refuses a second live job for the same user", async () => {
      await seedJob();
      expect(await mint()).toBeUndefined();
    });

    it("refuses a second live business job", async () => {
      await seedJob({ scope: "business", userId: undefined });
      expect(await mint({ scope: "business", userId: undefined })).toBeUndefined();
    });

    it("lets another user mint while one is live", async () => {
      await seedJob();
      expect(await mint({ userId: "user-2" })).toBeDefined();
    });

    it("frees the target once the live job reaches a terminal state", async () => {
      const first = await seedJob();
      await abandonCuratorJob(database as unknown as Queryable, first.id, "failed");
      expect(await mint()).toBeDefined();
    });
  });

  describe("attachRun", () => {
    it("binds a Run and tolerates the same Run being re-attached", async () => {
      const job = await seedJob();
      await repo.attachRun(job.id, "run-1");
      await repo.attachRun(job.id, "run-1");
      expect((await repo.getJob(BUSINESS, job.id))?.runId).toBe("run-1");
    });

    it("refuses to rebind a job to a different Run", async () => {
      const job = await seedJob();
      await repo.attachRun(job.id, "run-1");
      await expect(repo.attachRun(job.id, "run-2")).rejects.toThrow(/already bound/);
    });
  });

  describe("settle", () => {
    it.each<[CuratorExecutionMode, string]>([
      ["apply", "pending"],
      ["shadow", "shadowed"],
    ])("records %s effects in the %s state", async (executionMode, state) => {
      const job = await seedJob({ executionMode });
      await settle(job, [{ kind: "memory_patch", payload: { section: "identity" } }]);
      const effects = await repo.listEffects(job.id);
      expect(effects).toHaveLength(1);
      expect(effects[0]?.state).toBe(state);
      expect(effects[0]?.executionMode).toBe(executionMode);
    });

    it("forbids a shadow effect in any non-terminal state", async () => {
      const job = await seedJob({ executionMode: "shadow" });
      await expect(
        database.query(
          `INSERT INTO curator_effect
             (id, job_id, business_id, kind, generation, execution_mode, state, payload)
           VALUES ($1, $2, $3, 'memory_patch', 1, 'shadow', 'pending', '{}'::jsonb)`,
          [`${job.id}:1:0`, job.id, BUSINESS]
        )
      ).rejects.toThrow(/curator_effect_shadow_is_terminal/);
    });

    it("terminalizes the job in the same write as its effects", async () => {
      const job = await seedJob();
      await settle(job, [{ kind: "proposal", payload: {} }]);
      const stored = await repo.getJob(BUSINESS, job.id);
      expect(stored?.state).toBe("succeeded");
      expect(stored?.outputDigest).toBe("output-1");
    });

    it("replays a retried post without writing twice", async () => {
      const job = await seedJob();
      const effects = [{ kind: "proposal", payload: { kind: "create_agent" } }];
      const first = await settle(job, effects, [{ effect: "x", reason: "y" }]);
      const second = await settle(job, effects, [{ effect: "x", reason: "y" }]);
      expect(first).toEqual({ recorded: 1, rejected: 1, replayed: false });
      expect(second).toEqual({ recorded: 1, rejected: 1, replayed: true });
      expect(await repo.listEffects(job.id)).toHaveLength(1);
      expect(await repo.listRejections(job.id)).toHaveLength(1);
    });

    it("refuses a second, different answer for a settled job", async () => {
      const job = await seedJob();
      await settle(job, [{ kind: "proposal", payload: { n: 1 } }]);
      await expect(
        settle(job, [{ kind: "proposal", payload: { n: 2 } }], [], "output-2")
      ).rejects.toBeInstanceOf(CuratorSettlementConflictError);
      expect(await repo.listEffects(job.id)).toHaveLength(1);
    });

    it("records rejections rather than dropping them", async () => {
      const job = await seedJob();
      await settle(
        job,
        [],
        [
          { effect: "memory_patch", reason: "unsupported_claim", detail: "no citation" },
          { effect: "proposal", reason: "unknown_subject" },
        ]
      );
      const rejections = await repo.listRejections(job.id);
      expect(rejections.map((r) => r.reason)).toEqual(["unsupported_claim", "unknown_subject"]);
      expect(rejections[0]?.detail).toBe("no citation");
      expect(rejections[1]?.detail).toBeUndefined();
    });

    it("drops a job's effects and rejections with the job", async () => {
      const job = await seedJob();
      await settle(job, [{ kind: "proposal", payload: {} }], [{ effect: "x", reason: "y" }]);
      await database.query("DELETE FROM curator_job WHERE id = $1", [job.id]);
      expect(await repo.listEffects(job.id)).toEqual([]);
      expect(await repo.listRejections(job.id)).toEqual([]);
    });
  });

  describe("candidates", () => {
    it("lists only open candidates of the asked direction, oldest first", async () => {
      await candidate("knowledge_promotion", "open", { n: 1 });
      await candidate("knowledge_promotion", "consumed", { n: 2 });
      await candidate("proposal_seed", "open", { n: 3 });
      const open = await repo.listOpenCandidates(
        database as unknown as Queryable,
        BUSINESS,
        "knowledge_promotion",
        10
      );
      expect(open.map((c) => c.payload)).toEqual([{ n: 1 }]);
    });

    it("reads exactly the pinned ids, in the pinned order", async () => {
      const first = await candidate("knowledge_promotion", "open", { n: 1 });
      const second = await candidate("knowledge_promotion", "open", { n: 2 });
      await candidate("knowledge_promotion", "open", { n: 3 });
      const read = await repo.readCandidates(BUSINESS, "knowledge_promotion", [second, first]);
      expect(read.map((c) => c.payload)).toEqual([{ n: 2 }, { n: 1 }]);
    });

    it("drops a pinned candidate that is no longer open or is the wrong direction", async () => {
      const consumed = await candidate("knowledge_promotion", "consumed", { n: 1 });
      const seed = await candidate("proposal_seed", "open", { n: 2 });
      expect(await repo.readCandidates(BUSINESS, "knowledge_promotion", [consumed, seed])).toEqual(
        []
      );
    });

    it("does not read another business's candidate", async () => {
      const mine = await candidate("knowledge_promotion", "open", { n: 1 });
      expect(await repo.readCandidates(OTHER_BUSINESS, "knowledge_promotion", [mine])).toEqual([]);
    });
  });
});
