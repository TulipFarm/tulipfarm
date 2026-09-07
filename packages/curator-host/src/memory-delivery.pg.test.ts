import { PGlite } from "@electric-sql/pglite";
import type { CuratorEffect } from "@tulipfarm/curator";
import {
  hashMemorySection,
  MEMORY_DOCUMENT_STORAGE_STATEMENTS,
  MemoryDocumentRepo,
} from "@tulipfarm/memory";
import { MEMORY_SECTION_KEYS } from "@tulipfarm/schema";
import {
  CURATOR_STORAGE_STATEMENTS,
  CURATOR_WORK_STORAGE_STATEMENTS,
  type CuratorExecutionMode,
  type CuratorJobRecord,
  CuratorRepo,
  type Queryable,
  TASK_STORAGE_STATEMENTS,
  type TransactionPort,
} from "@tulipfarm/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CuratorMemoryDelivery } from "./memory-delivery";

const BUSINESS = "business-1";
const USER = "user-1";
const NOW = new Date("2026-08-21T00:00:00.000Z");

function transactions(database: PGlite): TransactionPort {
  return { withTransaction: (operation) => database.transaction((tx) => operation(tx as never)) };
}

function memoryPatch(): Extract<CuratorEffect, { kind: "memory_patch" }> {
  return {
    kind: "memory_patch",
    section: "identity",
    add: ["Works on the payments team"],
    remove: [],
    citations: [{ turnId: "turn-1", quote: "I work on the payments team" }],
  };
}

describe("CuratorMemoryDelivery (PostgreSQL)", () => {
  let database: PGlite;
  let curator: CuratorRepo;
  let documents: MemoryDocumentRepo;

  async function seed(
    executionMode: CuratorExecutionMode = "apply",
    payload: unknown = memoryPatch()
  ): Promise<CuratorJobRecord> {
    const job = await curator.insertJob(database as unknown as Queryable, {
      businessId: BUSINESS,
      scope: "user",
      userId: USER,
      runId: "run-1",
      state: "running",
      executionMode: "shadow",
      manifestDigest: "digest-1",
      manifest: { work: [], turnIds: ["turn-1"], candidateIds: [] },
    });
    if (!job) throw new Error("expected job");
    await curator.pinContext(job.id, {
      memoryRevisionId: null,
      sectionHashes: Object.fromEntries(
        MEMORY_SECTION_KEYS.map((section) => [section, hashMemorySection("")])
      ),
      candidateDigest: "candidates",
      seedDigest: "seeds",
      soulDigest: null,
    });
    await curator.settle({
      job,
      outputDigest: `output-${job.id}`,
      generation: 1,
      effects: [{ kind: "memory_patch", payload, executionMode }],
      rejections: [],
    });
    return job;
  }

  function delivery() {
    return new CuratorMemoryDelivery({ repo: curator, documents, now: () => NOW });
  }

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of [
      ...TASK_STORAGE_STATEMENTS,
      ...MEMORY_DOCUMENT_STORAGE_STATEMENTS,
      ...CURATOR_STORAGE_STATEMENTS,
      ...CURATOR_WORK_STORAGE_STATEMENTS,
    ]) {
      await database.exec(sql);
    }
    curator = new CuratorRepo(database as unknown as Queryable);
    documents = new MemoryDocumentRepo(transactions(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec(
      "DELETE FROM curator_job; DELETE FROM user_memory_revisions; DELETE FROM user_memory;"
    );
  });

  it("applies a pending patch to its job's user and records Run provenance", async () => {
    const job = await seed();

    await expect(delivery().run(BUSINESS)).resolves.toEqual({
      applied: 1,
      superseded: 0,
      retryableFailed: 0,
      terminalRejected: 0,
    });

    expect(await documents.render(BUSINESS, USER)).toContain("Works on the payments team");
    const revision = await database.query<{ writer: string; writer_run_id: string }>(
      `SELECT writer, writer_run_id
         FROM user_memory_revisions
        WHERE business_id = $1 AND user_id = $2`,
      [BUSINESS, USER]
    );
    expect(revision.rows).toEqual([{ writer: "curator", writer_run_id: "run-1" }]);
    expect((await curator.listEffects(job.id))[0]?.state).toBe("succeeded");
  });

  it("supersedes a patch when its section changed after context resolution", async () => {
    const job = await seed();
    await documents.applyDelta({
      businessId: BUSINESS,
      userId: USER,
      delta: { section: "identity", add: ["Changed after the Curator read it"] },
      writer: "tool",
      now: NOW,
    });

    await expect(delivery().run(BUSINESS)).resolves.toMatchObject({ superseded: 1 });
    expect(await documents.render(BUSINESS, USER)).not.toContain("Works on the payments team");
    expect((await curator.listEffects(job.id))[0]?.state).toBe("superseded");
  });

  it("never revives a historical shadow effect", async () => {
    const job = await seed("shadow");

    await expect(delivery().run(BUSINESS)).resolves.toEqual({
      applied: 0,
      superseded: 0,
      retryableFailed: 0,
      terminalRejected: 0,
    });

    expect(await documents.render(BUSINESS, USER)).toBe("");
    expect((await curator.listEffects(job.id))[0]?.state).toBe("shadowed");
  });

  it("terminally rejects a malformed payload instead of choosing its scope or provenance", async () => {
    const job = await seed("apply", {
      kind: "memory_patch",
      section: "identity",
      add: ["Forged"],
      citations: [],
      userId: "user-2",
    });

    await expect(delivery().run(BUSINESS)).resolves.toMatchObject({ terminalRejected: 1 });
    expect(await documents.render(BUSINESS, USER)).toBe("");
    expect(await documents.render(BUSINESS, "user-2")).toBe("");
    expect((await curator.listEffects(job.id))[0]?.state).toBe("terminal_rejected");
  });

  it("terminally rejects a citation outside the job's pinned Turns", async () => {
    const job = await seed("apply", {
      ...memoryPatch(),
      citations: [{ turnId: "turn-2", quote: "I work on the payments team" }],
    });

    await expect(delivery().run(BUSINESS)).resolves.toMatchObject({ terminalRejected: 1 });
    expect(await documents.render(BUSINESS, USER)).toBe("");
    expect((await curator.listEffects(job.id))[0]?.state).toBe("terminal_rejected");
  });

  it("terminally rejects an effect whose settled job has no Run or context provenance", async () => {
    const job = await seed();
    await database.query("UPDATE curator_job SET run_id = NULL, context_pin = NULL WHERE id = $1", [
      job.id,
    ]);

    await expect(delivery().run(BUSINESS)).resolves.toMatchObject({ terminalRejected: 1 });
    expect(await documents.render(BUSINESS, USER)).toBe("");
    expect((await curator.listEffects(job.id))[0]?.state).toBe("terminal_rejected");
  });

  it("terminally rejects malformed stored context and source provenance", async () => {
    const job = await seed();
    await database.query(
      `UPDATE curator_job
          SET context_pin = '{}'::jsonb,
              manifest = '{"work":[],"candidateIds":[]}'::jsonb
        WHERE id = $1`,
      [job.id]
    );

    await expect(delivery().run(BUSINESS)).resolves.toMatchObject({ terminalRejected: 1 });
    expect(await documents.render(BUSINESS, USER)).toBe("");
    expect((await curator.listEffects(job.id))[0]?.state).toBe("terminal_rejected");
  });

  it("leaves transient Memory-store failures retryable", async () => {
    const job = await seed();
    await database.exec("ALTER TABLE user_memory RENAME TO unavailable_user_memory");
    try {
      await expect(delivery().run(BUSINESS)).resolves.toMatchObject({ retryableFailed: 1 });
    } finally {
      await database.exec("ALTER TABLE unavailable_user_memory RENAME TO user_memory");
    }
    expect((await curator.listEffects(job.id))[0]?.state).toBe("retryable_failed");
  });

  it("does not replay an effect after it succeeds", async () => {
    const job = await seed();
    await delivery().run(BUSINESS);

    await expect(delivery().run(BUSINESS)).resolves.toEqual({
      applied: 0,
      superseded: 0,
      retryableFailed: 0,
      terminalRejected: 0,
    });
    expect((await curator.listEffects(job.id))[0]?.state).toBe("succeeded");
    const revisions = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM user_memory_revisions
        WHERE business_id = $1 AND user_id = $2`,
      [BUSINESS, USER]
    );
    expect(revisions.rows[0]?.count).toBe(1);
  });
});
