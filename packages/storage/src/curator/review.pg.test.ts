import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../ports";
import { TASK_STORAGE_STATEMENTS } from "../tasks/task-repo";
import { CURATOR_ADMISSION_STATEMENTS } from "./admission";
import { type CuratorJobRecord, CuratorRepo } from "./repo";
import { listCuratorShadowEffects, summarizeCuratorShadow } from "./review";
import { CURATOR_STORAGE_STATEMENTS } from "./schema";
import { CURATOR_WORK_STORAGE_STATEMENTS } from "./work";

const BUSINESS = "business-1";
const OTHER_BUSINESS = "business-2";
const EPOCH = new Date("2020-01-01T00:00:00Z");

describe("curator shadow review reads (PostgreSQL)", () => {
  let database: PGlite;
  let repo: CuratorRepo;

  const seedJob = async (overrides: Partial<CuratorJobRecord> = {}): Promise<CuratorJobRecord> => {
    const job = await repo.insertJob(database as unknown as Queryable, {
      businessId: BUSINESS,
      scope: "user",
      userId: "user-1",
      state: "minted",
      executionMode: "shadow",
      manifestDigest: `digest-${Math.random()}`,
      manifest: { work: [], turnIds: [], candidateIds: [] },
      ...overrides,
    });
    if (!job) throw new Error("expected the job to mint");
    return job;
  };

  const settle = async (
    job: CuratorJobRecord,
    effects: readonly { kind: string; payload: unknown }[],
    rejections: readonly { effect: string; reason: string }[] = []
  ) =>
    repo.settle({
      job,
      outputDigest: `out-${job.id}`,
      generation: 1,
      effects: effects as Parameters<CuratorRepo["settle"]>[0]["effects"],
      rejections,
    });

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of [
      ...TASK_STORAGE_STATEMENTS,
      ...CURATOR_STORAGE_STATEMENTS,
      ...CURATOR_WORK_STORAGE_STATEMENTS,
      ...CURATOR_ADMISSION_STATEMENTS,
    ]) {
      await database.exec(statement);
    }
    repo = new CuratorRepo(database as unknown as Queryable);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("DELETE FROM curator_job");
  });

  describe("summary", () => {
    it("counts jobs, effects and rejections without returning any content", async () => {
      const job = await seedJob();
      await settle(
        job,
        [
          { kind: "memory_patch", payload: { section: "identity", add: ["Lives in Bangalore"] } },
          { kind: "proposal", payload: { proposalKind: "create_agent" } },
        ],
        [{ effect: "memory_patch", reason: "quote_not_found" }]
      );

      const summary = await summarizeCuratorShadow(
        database as unknown as Queryable,
        BUSINESS,
        EPOCH
      );

      expect(summary.jobs).toEqual([{ scope: "user", state: "succeeded", count: 1 }]);
      expect(summary.effects).toEqual([
        { kind: "memory_patch", state: "shadowed", count: 1 },
        { kind: "proposal", state: "shadowed", count: 1 },
      ]);
      expect(summary.rejections).toEqual([{ reason: "quote_not_found", count: 1 }]);
      expect(JSON.stringify(summary)).not.toContain("Bangalore");
    });

    it("never counts another business's loop", async () => {
      await settle(await seedJob({ businessId: OTHER_BUSINESS }), [
        { kind: "proposal", payload: {} },
      ]);

      const summary = await summarizeCuratorShadow(
        database as unknown as Queryable,
        BUSINESS,
        EPOCH
      );

      expect(summary.jobs).toEqual([]);
      expect(summary.effects).toEqual([]);
    });

    it("excludes everything older than the window", async () => {
      await settle(await seedJob(), [{ kind: "proposal", payload: {} }]);

      const summary = await summarizeCuratorShadow(
        database as unknown as Queryable,
        BUSINESS,
        new Date(Date.now() + 60_000)
      );

      expect(summary.effects).toEqual([]);
      expect(summary.rejections).toEqual([]);
    });

    it("scopes rejections by their job's window, not their own age", async () => {
      const job = await seedJob();
      await settle(job, [], [{ effect: "proposal", reason: "no_directive_evidence" }]);
      await database.query("UPDATE curator_job SET created_at = $1", [
        new Date("2019-01-01T00:00:00Z"),
      ]);

      const summary = await summarizeCuratorShadow(
        database as unknown as Queryable,
        BUSINESS,
        EPOCH
      );

      expect(summary.rejections).toEqual([]);
    });
  });

  describe("effect listing", () => {
    it("carries the producing job's scope and subject so the caller can redact", async () => {
      const user = await seedJob({ userId: "user-7" });
      await settle(user, [{ kind: "memory_patch", payload: { section: "identity" } }]);
      const business = await seedJob({ scope: "business", userId: undefined });
      await settle(business, [{ kind: "knowledge_page", payload: { title: "Shipping" } }]);

      const rows = await listCuratorShadowEffects(
        database as unknown as Queryable,
        BUSINESS,
        EPOCH,
        10
      );

      expect(rows.map((row) => [row.kind, row.scope, row.userId])).toEqual(
        expect.arrayContaining([
          ["memory_patch", "user", "user-7"],
          ["knowledge_page", "business", null],
        ])
      );
    });

    it("returns the newest first and honours the cap", async () => {
      for (let index = 0; index < 4; index += 1) {
        const job = await seedJob({ userId: `user-${index}` });
        await settle(job, [{ kind: "proposal", payload: { n: index } }]);
        await database.query("UPDATE curator_effect SET created_at = $1 WHERE job_id = $2", [
          new Date(Date.UTC(2026, 0, index + 1)),
          job.id,
        ]);
      }

      const rows = await listCuratorShadowEffects(
        database as unknown as Queryable,
        BUSINESS,
        EPOCH,
        2
      );

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => (row.payload as { n: number }).n)).toEqual([3, 2]);
    });

    it("never lists another business's effects", async () => {
      await settle(await seedJob({ businessId: OTHER_BUSINESS }), [
        { kind: "proposal", payload: {} },
      ]);

      expect(
        await listCuratorShadowEffects(database as unknown as Queryable, BUSINESS, EPOCH, 10)
      ).toEqual([]);
    });
  });
});
