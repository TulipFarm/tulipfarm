import { PGlite } from "@electric-sql/pglite";
import {
  ArtifactService,
  DurableInvocationGateway,
  INVOCATION_STORAGE_STATEMENTS,
  PgDurableInvocationStore,
  RunLeaseManager,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import { INVOCATION_REQUEST_SCHEMAS } from "@tulipfarm/schema";
import {
  ARTIFACT_STORAGE_STATEMENTS,
  ArtifactStore,
  ambientTransactionPort,
  CURATOR_ADMISSION_STATEMENTS,
  CURATOR_STORAGE_STATEMENTS,
  CURATOR_WORK_STORAGE_STATEMENTS,
  CuratorAdmissionLedger,
  CuratorMintStore,
  CuratorRepo,
  type Queryable,
  RUN_STORAGE_STATEMENTS,
  RunStore,
  recordCuratorWork,
  TASK_STORAGE_STATEMENTS,
  transactionPort,
} from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CuratorMinter } from "./mint";
import { CuratorRecovery } from "./recovery";

const BUSINESS = "business-1";
const USER = "user-1";
const OWNER = "worker-1";
const MINTED_AT = new Date("2026-08-19T01:00:48.000Z");
const SWEPT_AT = new Date("2026-08-19T01:10:48.000Z");
const LIMITS = {
  workLimit: 50,
  candidateLimit: 50,
  runCostMicros: 50_000,
  dailyCapMicros: 5_000_000,
};

const validator = new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS);

describe("a Curator Run parked for reconciliation", () => {
  let database: PGlite;
  let pool: Queryable;
  let repo: CuratorRepo;
  let minter: CuratorMinter;
  let recovery: CuratorRecovery;
  let runs: RunStore;

  beforeEach(async () => {
    database = new PGlite();
    pool = database as unknown as Queryable;
    for (const statement of [
      ...TASK_STORAGE_STATEMENTS,
      ...RUN_STORAGE_STATEMENTS,
      ...ARTIFACT_STORAGE_STATEMENTS,
      ...INVOCATION_STORAGE_STATEMENTS,
      ...CURATOR_STORAGE_STATEMENTS,
      ...CURATOR_WORK_STORAGE_STATEMENTS,
      ...CURATOR_ADMISSION_STATEMENTS,
    ])
      await database.exec(statement);

    repo = new CuratorRepo(pool);
    runs = new RunStore(transactionPort(pool));
    const invocations = new DurableInvocationGateway({
      store: new PgDurableInvocationStore(
        transactionPort(pool),
        (transaction) =>
          new ArtifactService(new ArtifactStore(ambientTransactionPort(transaction)), validator)
      ),
      validator,
    });
    minter = new CuratorMinter({
      store: new CuratorMintStore(pool, repo, new CuratorAdmissionLedger(pool), LIMITS),
      repo,
      pool,
      invocations,
      providerAvailable: async () => true,
      soulDigest: () => "a".repeat(64),
      now: () => MINTED_AT,
    });
    recovery = new CuratorRecovery({ repo, minter, now: () => SWEPT_AT });
  });

  afterEach(async () => await database.close());

  const mint = async (): Promise<{ jobId: string; runId: string }> => {
    await recordCuratorWork(
      pool,
      { businessId: BUSINESS, userId: USER, reason: "turn_completed", sourceKey: "turn-1" },
      MINTED_AT
    );
    const minted = await minter.mintForUser(BUSINESS, USER);
    if (minted.outcome !== "minted") throw new Error(`mint refused: ${minted.reason}`);
    return { jobId: minted.jobId, runId: minted.runId };
  };

  /**
   * Exactly what `RunDispatcher` does when an executor throws: claim, start, then release the Run
   * to `needs_reconciliation`. The Curator executor never touches its own State, so the State the
   * gateway created stays `pending` with no attempts — which is what the Run inspector renders.
   */
  const parkForReconciliation = async (runId: string): Promise<void> => {
    const leases = new RunLeaseManager(runs);
    const claimed = await leases.claimBatch({
      businessId: BUSINESS,
      owner: OWNER,
      now: MINTED_AT,
      leaseDurationMs: 60_000,
      limit: 10,
    });
    const run = claimed.find((candidate) => candidate.id === runId);
    if (!run) throw new Error("dispatcher claimed nothing");
    const started = await leases.claim({
      businessId: BUSINESS,
      runId,
      owner: OWNER,
      now: MINTED_AT,
      leaseDurationMs: 60_000,
      expectedVersion: run.version,
      expectedStatus: "claimed",
      status: "running",
    });
    if (!started.run) throw new Error("dispatcher could not start the Run");
    await leases.release({
      businessId: BUSINESS,
      runId,
      expectedVersion: started.run.version,
      expectedStatus: "running",
      status: "needs_reconciliation",
      now: MINTED_AT,
    });
  };

  const workStatuses = async (): Promise<string[]> =>
    (
      await pool.query<{ status: string }>(
        "SELECT status FROM curator_user_work ORDER BY source_key"
      )
    ).rows.map((row) => row.status);

  it("reproduces the reported shape: parked Run, pending State, zero attempts", async () => {
    const { runId } = await mint();
    await parkForReconciliation(runId);

    expect((await runs.find(BUSINESS, runId))?.status).toBe("needs_reconciliation");
    const states = await runs.listStates(BUSINESS, runId);
    expect(states.map((state) => [state.key, state.status])).toEqual([["invoke", "pending"]]);
    const attempts = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM state_attempts WHERE run_id = $1",
      [runId]
    );
    expect(attempts.rows[0]?.count).toBe(0);
  });

  it("frees the target of a job whose Run was parked, so the loop can mint again", async () => {
    const { runId } = await mint();
    await parkForReconciliation(runId);

    expect(await recovery.run(BUSINESS)).toEqual({ recovered: 0, abandoned: 1 });
    expect(await workStatuses()).toEqual(["due"]);
    await expect(minter.mintForUser(BUSINESS, USER)).resolves.toMatchObject({ outcome: "minted" });
  });

  it("terminalizes the parked Run it gave up on, so no Run is left unresolvable", async () => {
    const { runId } = await mint();
    await parkForReconciliation(runId);

    await recovery.run(BUSINESS);

    expect((await runs.find(BUSINESS, runId))?.status).toBe("failed");
  });

  it("leaves a Run that is merely slow alone", async () => {
    const { jobId, runId } = await mint();
    expect(await recovery.run(BUSINESS)).toEqual({ recovered: 0, abandoned: 0 });
    expect((await runs.find(BUSINESS, runId))?.status).toBe("queued");
    expect((await repo.getJob(BUSINESS, jobId))?.state).toBe("minted");
  });

  it("never claws back a job that already answered", async () => {
    const { jobId, runId } = await mint();
    await parkForReconciliation(runId);
    await pool.query("UPDATE curator_job SET output_digest = 'settled' WHERE id = $1", [jobId]);

    expect(await recovery.run(BUSINESS)).toEqual({ recovered: 0, abandoned: 1 });
    expect((await repo.getJob(BUSINESS, jobId))?.state).toBe("minted");
    expect(await workStatuses()).toEqual(["claimed"]);
    // An answer may have landed, so the Run stays parked rather than being called failed.
    expect((await runs.find(BUSINESS, runId))?.status).toBe("needs_reconciliation");
  });
});
