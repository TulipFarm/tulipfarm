import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  ArtifactService,
  DurableInvocationGateway,
  DurableWaitManager,
  PgDurableInvocationStore,
  RunResumeGateway,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import { CHAT_REQUEST_SCHEMA_REF, INVOCATION_REQUEST_SCHEMAS } from "@tulipfarm/schema";
import { ArtifactStore, RunStore, WaitStore } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ambientTransactionPort, type Queryable, transactionPort } from "../db";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { ApprovalsRepo } from "./runtime-repo";
import { ToolApprovalService } from "./tool-approvals";

/**
 * Approvals as kernel waits, over real SQL (plan §5).
 *
 * The claim under test is that an approval is a *pause* rather than a restart: the Run that asked
 * stops holding a lease, a human decides at their own pace, and the very same Run is requeued. That
 * is only provable against the real `runs` / `run_waits` tables, because what makes it true is the
 * kernel's compare-and-swap and the wait's single-use token, not anything this service remembers.
 */

const SUBJECT = { kind: "user", id: "user-1" } as const;
const PRINCIPAL = `${SUBJECT.kind}:${SUBJECT.id}`;
const STATE_KEY = "invoke";

describe("tool approvals as durable waits", () => {
  let db: PGlite;
  let runs: RunStore;
  let repo: ApprovalsRepo;
  let approvals: ToolApprovalService;
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
    });

    const transactions = transactionPort(queryable);
    runs = new RunStore(transactions);
    repo = new ApprovalsRepo(queryable);
    approvals = new ToolApprovalService({
      repo,
      waits: new DurableWaitManager(new WaitStore(transactions), new RunResumeGateway(runs)),
    });
  });

  afterEach(async () => {
    await db.close();
  });

  /** Mints a chat Run and drives it to `running`, where a turn asks for an approval. */
  async function startRunningRun(idempotencyKey = "key-1"): Promise<string> {
    const started = await invocations.start({
      source: "chat",
      runSource: "chat",
      businessId: DEPLOYMENT_BUSINESS_ID,
      initiator: SUBJECT,
      effectiveSubject: SUBJECT,
      definitionRef: "published:agent:assistant",
      payload: {
        conversationId: "conversation-1",
        message: { role: "user", content: "delete it" },
        autonomy: "approval-required",
      },
      payloadSchemaRef: CHAT_REQUEST_SCHEMA_REF,
      idempotencyKey,
    });

    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, started.runId, {
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
      leaseOwner: "worker-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, started.runId, {
      expectedVersion: 1,
      expectedStatus: "claimed",
      status: "running",
      leaseOwner: "worker-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    return started.runId;
  }

  /** What `AgentStateRunner` does when the loop reports `awaiting_approval`. */
  async function park(runId: string, approvalId: string): Promise<{ waitId: string }> {
    const registered = await approvals.registerWait({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      stateKey: STATE_KEY,
      approvalId,
      subject: SUBJECT,
    });
    const state = await runs.findState(DEPLOYMENT_BUSINESS_ID, runId, STATE_KEY);
    await runs.transitionState(DEPLOYMENT_BUSINESS_ID, runId, STATE_KEY, {
      expectedVersion: state?.version ?? 0,
      expectedStatus: state?.status ?? "ready",
      status: "waiting",
    });
    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, runId, {
      expectedVersion: 2,
      expectedStatus: "running",
      status: "waiting",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    return registered;
  }

  async function requestApproval(
    runId: string,
    toolCallId = "call-1"
  ): Promise<{ approvalId: string }> {
    const decision = await approvals.decide({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      toolCallId,
      toolName: "record_delete",
      args: { id: "record-1" },
    });
    if (decision.status !== "pending") throw new Error(`expected pending, got ${decision.status}`);
    return { approvalId: decision.approvalId };
  }

  async function countRuns(): Promise<number> {
    const { rows } = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM runs");
    return Number(rows[0]?.count ?? "0");
  }

  it("parks the Run and resumes the same runId, minting no second Run", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);
    await park(runId, approvalId);

    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({
      status: "waiting",
      leaseOwner: null,
    });

    expect(
      await approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: PRINCIPAL,
      })
    ).toBe("resumed");

    // The same Run, requeued for the dispatcher — not a successor carrying the answer.
    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({
      id: runId,
      status: "queued",
    });
    expect(await countRuns()).toBe(1);
    expect(await runs.findState(DEPLOYMENT_BUSINESS_ID, runId, STATE_KEY)).toMatchObject({
      status: "waiting",
    });
  });

  it("honours the settled decision when the resumed loop re-proposes under a new call id", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId, "call-1");
    await park(runId, approvalId);
    await approvals.signal({
      businessId: DEPLOYMENT_BUSINESS_ID,
      approvalId,
      decision: "approved",
      principal: PRINCIPAL,
    });

    // The resumed turn re-assembles Context and the model proposes again: same intent, new call id.
    expect(
      await approvals.decide({
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId,
        toolCallId: "call-2",
        toolName: "record_delete",
        args: { id: "record-1" },
      })
    ).toEqual({ status: "approved" });

    expect((await repo.listPending("tool_call")).length).toBe(0);
  });

  it("asks again for a different intent on the same Run", async () => {
    const runId = await startRunningRun();
    const first = await requestApproval(runId);

    const other = await approvals.decide({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      toolCallId: "call-2",
      toolName: "record_delete",
      args: { id: "record-2" },
    });

    expect(other.status).toBe("pending");
    expect(other).not.toMatchObject({ approvalId: first.approvalId });
  });

  it("denies the call rather than executing it when the decision was no", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);
    await park(runId, approvalId);

    expect(
      await approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "denied",
        principal: PRINCIPAL,
      })
    ).toBe("resumed");

    expect(
      await approvals.decide({
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId,
        toolCallId: "call-2",
        toolName: "record_delete",
        args: { id: "record-1" },
      })
    ).toEqual({ status: "denied", reason: "denied by operator" });
  });

  it("parks on the wait it is already on when a redelivered turn registers twice", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);
    const first = await park(runId, approvalId);

    const second = await approvals.registerWait({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      stateKey: STATE_KEY,
      approvalId,
      subject: SUBJECT,
    });

    expect(second.waitId).toBe(first.waitId);
    const { rows } = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM run_waits WHERE run_id = $1",
      [runId]
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("refuses a principal the Run does not act as, without recording their decision", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);
    await park(runId, approvalId);

    expect(
      await approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: "user:intruder",
      })
    ).toBe("forbidden");

    // Neither settled nor resumed: the Run is still parked and still awaiting its own subject.
    expect(await repo.findById(approvalId)).toMatchObject({ status: "pending" });
    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({ status: "waiting" });
  });

  it("resumes once, so a replayed decision cannot requeue the Run a second time", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);
    await park(runId, approvalId);

    await approvals.signal({
      businessId: DEPLOYMENT_BUSINESS_ID,
      approvalId,
      decision: "approved",
      principal: PRINCIPAL,
    });
    // A second click, or a retried request, after the Run was already picked back up.
    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, runId, {
      expectedVersion: 4,
      expectedStatus: "queued",
      status: "claimed",
      leaseOwner: "worker-2",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(
      await approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "denied",
        principal: PRINCIPAL,
      })
    ).toBe("already_settled");

    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({ status: "claimed" });
  });

  it("reports an approval it holds no wait for, so the caller's own path still runs", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);

    // Requested but never parked: nothing to resume, and settling it here would strand the row.
    expect(
      await approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: PRINCIPAL,
      })
    ).toBe("not_found");
    expect(await repo.findById(approvalId)).toMatchObject({ status: "pending" });
  });
});
