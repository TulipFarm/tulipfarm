import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  ArtifactService,
  DurableInvocationGateway,
  DurableWaitManager,
  PgDurableInvocationStore,
  type RegisterWaitInput,
  RunResumeGateway,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import { INVOCATION_REQUEST_SCHEMAS, MANUAL_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import { ArtifactStore, RunStore, WaitStore } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ambientTransactionPort, type Queryable, transactionPort, withTransaction } from "../db";
import { InternalRoutineApprovalHost } from "../internal/routine-approval-host";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { RoutineApprovalService } from "./routine-approvals";
import { ApprovalsRepo } from "./runtime-repo";

/**
 * A Routine State's approval, over real SQL.
 *
 * The claim under test is the same one Tool approvals make — the Run parks and the *same* Run is
 * requeued — plus the one this path adds: authority is a **role**, not a person. Both are only
 * provable against the real `runs` / `run_waits` / `approvals` tables, because what makes them true
 * is the kernel's compare-and-swap under the wait's lock, not anything either service remembers.
 */

const SUBJECT = { kind: "user", id: "user-1" } as const;
const STATE_KEY = "Fanout#0/Approve";
const APPROVER_ROLE = "admin";

/** The plan the Worker sends: the wait as the run-kernel derived it from the authored State. */
function waitPlan(
  overrides: Partial<RegisterWaitInput> = {}
): Omit<RegisterWaitInput, "businessId" | "runId"> {
  const now = new Date();
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    stateKey: STATE_KEY,
    kind: "approval",
    aggregation: "first",
    schemaRef: "wait:approval:Approve",
    allowedPrincipals: [`role:${APPROVER_ROLE}`],
    expectedSignals: 1,
    quorum: null,
    deadlineAt: new Date(now.getTime() + 60_000).toISOString(),
    createdAt: now.toISOString(),
    ...overrides,
  };
}

describe("routine approvals as durable waits", () => {
  let db: PGlite;
  let runs: RunStore;
  let repo: ApprovalsRepo;
  let host: InternalRoutineApprovalHost;
  let approvals: RoutineApprovalService;
  let invocations: DurableInvocationGateway;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db as unknown as Queryable);

    const queryable = db as unknown as Queryable;
    const validator = new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS);
    invocations = new DurableInvocationGateway({
      store: new PgDurableInvocationStore(
        transactionPort(queryable),
        (transaction) =>
          new ArtifactService(new ArtifactStore(ambientTransactionPort(transaction)), validator)
      ),
      validator,
      routineDefinitions: {
        resolve: async () => ({
          bundle: { digest: "d".repeat(64), routineId: "routine-1", routineVersion: "1.0.0" },
          // The State the approval parks on: a wait is a child of a durable State row, so the
          // occurrence key here is the one the executor would have persisted before opening it.
          startState: { key: STATE_KEY, definitionRef: "published:routine:invoice#1.0.0" },
        }),
      },
    });

    const transactions = transactionPort(queryable);
    runs = new RunStore(transactions);
    repo = new ApprovalsRepo(queryable);
    const resume = new RunResumeGateway(runs);
    host = new InternalRoutineApprovalHost({
      runs,
      db: queryable,
      withTransaction: (operation) => withTransaction(queryable, operation),
      resume,
    });
    approvals = new RoutineApprovalService({
      repo,
      waits: new DurableWaitManager(new WaitStore(transactions), resume),
    });
  });

  afterEach(async () => {
    await db.close();
  });

  /** Mints a Routine Run and drives it to `running`, where a State asks for an approval. */
  async function startRoutineRun(idempotencyKey = "key-1"): Promise<string> {
    const started = await invocations.start({
      source: "manual",
      runSource: "routine",
      businessId: DEPLOYMENT_BUSINESS_ID,
      initiator: SUBJECT,
      effectiveSubject: SUBJECT,
      definitionRef: "published:routine:invoice",
      payload: { slug: "invoice", inputs: {} },
      payloadSchemaRef: MANUAL_REQUEST_SCHEMA_REF,
      idempotencyKey,
    });

    await reclaim(started.runId);
    return started.runId;
  }

  /** Moves the Run one step, against whatever version it currently carries. */
  async function step(
    runId: string,
    from: "queued" | "claimed" | "running",
    to: "claimed" | "running" | "waiting"
  ): Promise<void> {
    const run = await runs.find(DEPLOYMENT_BUSINESS_ID, runId);
    if (run === null) throw new Error(`run ${runId} is gone`);
    const held = to === "waiting" ? null : "worker-1";
    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, runId, {
      expectedVersion: run.version,
      expectedStatus: from,
      status: to,
      leaseOwner: held,
      leaseExpiresAt: held === null ? null : new Date(Date.now() + 60_000).toISOString(),
    });
  }

  /** A dispatcher picking the Run up: claimed, then executing. */
  async function reclaim(runId: string): Promise<void> {
    await step(runId, "queued", "claimed");
    await step(runId, "claimed", "running");
  }

  /** What the executor does after opening the approval: park the Run holding no lease. */
  async function park(runId: string): Promise<void> {
    await step(runId, "running", "waiting");
  }

  async function open(runId: string, overrides: Partial<RegisterWaitInput> = {}) {
    return host.open(DEPLOYMENT_BUSINESS_ID, runId, {
      stateKey: STATE_KEY,
      stateName: "Approve",
      wait: waitPlan(overrides),
    });
  }

  it("registers the wait and the approval together, and hands back no resume token", async () => {
    const runId = await startRoutineRun();
    const opened = await open(runId);

    expect(opened).toMatchObject({ decision: "pending" });
    expect(Object.keys(opened)).toEqual(["approvalId", "waitId", "decision"]);

    const row = await repo.findById(opened.approvalId);
    expect(row).toMatchObject({ kind: "routine_state", status: "pending" });
    // The token lives beside the approval, in the process that redeems it — never in the answer.
    expect((row?.payload as { resumeToken?: string }).resumeToken).toEqual(expect.any(String));
  });

  it("returns the approval already open for this State occurrence rather than asking twice", async () => {
    const runId = await startRoutineRun();
    const first = await open(runId);
    const second = await open(runId, { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });

    expect(second).toEqual(first);
    expect((await repo.listPending("routine_state")).length).toBe(1);
  });

  it("resumes the same Run when someone holding the authored role decides", async () => {
    const runId = await startRoutineRun();
    const { approvalId } = await open(runId);
    await park(runId);

    expect(
      await approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: `${SUBJECT.kind}:${SUBJECT.id}`,
        roles: [APPROVER_ROLE],
      })
    ).toBe("resumed");

    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({
      id: runId,
      status: "queued",
    });
    expect(await repo.findById(approvalId)).toMatchObject({ status: "approved" });

    // And what the requeued executor reads on replay is the decision, not another open request.
    await reclaim(runId);
    expect(await host.find(DEPLOYMENT_BUSINESS_ID, runId, STATE_KEY)).toMatchObject({
      approvalId,
      decision: "approved",
    });
  });

  it("refuses a decider holding none of the authored roles, leaving the Run parked", async () => {
    const runId = await startRoutineRun();
    const { approvalId } = await open(runId);
    await park(runId);

    expect(
      await approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: "user:user-2",
        roles: ["member"],
      })
    ).toBe("forbidden");

    // Neither the decision nor the Run moved: a refused decider must not settle the approval.
    expect(await repo.findById(approvalId)).toMatchObject({ status: "pending" });
    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({ status: "waiting" });
  });

  it("reads a pending approval past its deadline as expired, which is nobody's decision", async () => {
    const runId = await startRoutineRun();
    const now = new Date();
    await open(runId, {
      createdAt: new Date(now.getTime() - 120_000).toISOString(),
      deadlineAt: new Date(now.getTime() - 60_000).toISOString(),
    });

    expect(await host.find(DEPLOYMENT_BUSINESS_ID, runId, STATE_KEY)).toMatchObject({
      decision: "expired",
    });
  });

  it("refuses to open an approval against a Run no executor is holding", async () => {
    const runId = await startRoutineRun();
    await park(runId);

    await expect(open(runId)).rejects.toMatchObject({ code: "run_not_running" });
  });
});
