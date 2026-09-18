import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  ArtifactService,
  DurableInvocationGateway,
  DurableWaitError,
  DurableWaitManager,
  PgDurableInvocationStore,
  RunResumeGateway,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import {
  CHAT_REQUEST_SCHEMA_REF,
  canonicalHash,
  INVOCATION_REQUEST_SCHEMAS,
  mcpToolName,
} from "@tulipfarm/schema";
import { ArtifactStore, RunStore, type TransactionPort, WaitStore } from "@tulipfarm/storage";
import { normalizeToolIntent } from "@tulipfarm/tool-broker";
import { ApprovalsRepo, ToolApprovalService } from "@tulipfarm/tool-host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ambientTransactionPort, type Queryable, transactionPort } from "../db";
import { makeMigratedPglite } from "../test/pglite";

const SUBJECT = { kind: "user", id: "user-1" } as const;
const PRINCIPAL = `${SUBJECT.kind}:${SUBJECT.id}`;
const STATE_KEY = "invoke";

describe("tool approvals as durable waits", () => {
  let db: PGlite;
  let runs: RunStore;
  let repo: ApprovalsRepo;
  let approvals: ToolApprovalService;
  let invocations: DurableInvocationGateway;
  let transactions: TransactionPort;

  beforeEach(async () => {
    db = await makeMigratedPglite();

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

    transactions = transactionPort(queryable);
    runs = new RunStore(transactions);
    repo = new ApprovalsRepo(queryable);
    approvals = new ToolApprovalService({ transactions });
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
    const run = await runs.find(DEPLOYMENT_BUSINESS_ID, runId);
    if (run === null) throw new Error("expected Run");
    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, runId, {
      expectedVersion: run.version,
      expectedStatus: "running",
      status: "waiting",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    return registered;
  }

  async function resumeRunning(runId: string): Promise<void> {
    const run = await runs.find(DEPLOYMENT_BUSINESS_ID, runId);
    if (run === null) throw new Error("expected Run");
    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, runId, {
      expectedVersion: run.version,
      expectedStatus: "queued",
      status: "claimed",
      leaseOwner: "worker-2",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, runId, {
      expectedVersion: run.version + 1,
      expectedStatus: "claimed",
      status: "running",
      leaseOwner: "worker-2",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const state = await runs.findState(DEPLOYMENT_BUSINESS_ID, runId, STATE_KEY);
    if (state === null) throw new Error("expected State");
    await runs.transitionState(DEPLOYMENT_BUSINESS_ID, runId, STATE_KEY, {
      expectedVersion: state.version,
      expectedStatus: "waiting",
      status: "ready",
    });
    await runs.transitionState(DEPLOYMENT_BUSINESS_ID, runId, STATE_KEY, {
      expectedVersion: state.version + 1,
      expectedStatus: "ready",
      status: "claimed",
    });
    await runs.transitionState(DEPLOYMENT_BUSINESS_ID, runId, STATE_KEY, {
      expectedVersion: state.version + 2,
      expectedStatus: "claimed",
      status: "running",
    });
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
      requesterPrincipalId: "user:requester-1",
      demand: {
        demandedBy: "guardrail_rule",
        guardrailRevision: "gr-1",
        reason: "approval_required",
        ruleId: "rule-1",
      },
    });
    if (decision.status !== "pending") throw new Error(`expected pending, got ${decision.status}`);
    return { approvalId: decision.approvalId };
  }

  async function countRuns(): Promise<number> {
    const { rows } = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM runs");
    return Number(rows[0]?.count ?? "0");
  }

  function concurrentApprovalTransactions(): TransactionPort {
    // PGlite serializes transactions, so this adapter exposes the race while preserving the
    // lifetime and exclusion semantics of PostgreSQL's transaction-scoped advisory lock.
    let lockTail = Promise.resolve();
    let concurrentReads = 0;
    let releaseReads: (() => void) | undefined;
    const readsReady = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });

    return {
      withTransaction: async (operation) => {
        let releaseLock: (() => void) | undefined;
        let holdsLock = false;
        const queryable = {
          query: async (text: string, params?: readonly unknown[]) => {
            if (text.includes("pg_advisory_xact_lock")) {
              const previous = lockTail;
              lockTail = new Promise<void>((resolve) => {
                releaseLock = resolve;
              });
              await previous;
              holdsLock = true;
              return { rows: [{ pg_advisory_xact_lock: "" }] };
            }
            const result = await (db as unknown as Queryable).query(text, params);
            if (
              !holdsLock &&
              text.includes("COALESCE(payload->>'requestDigest', payload->>'intentDigest')")
            ) {
              concurrentReads += 1;
              if (concurrentReads === 2) releaseReads?.();
              await readsReady;
            }
            return result;
          },
        } as Queryable;
        try {
          return await operation(queryable);
        } finally {
          releaseLock?.();
        }
      },
    };
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

  it("reloads the exact prepared Tool intent after the approval service restarts", async () => {
    const runId = await startRunningRun();
    const toolName = mcpToolName("acme", "send");
    const args = { body: { fileId: "file-1" } };
    const mcp = {
      serverId: "acme",
      serverRevision: "a".repeat(64),
      accountId: "account-1",
      accountRevision: "7",
      subjectId: "user-1",
      authorizationId: "account-authorization-1",
    };
    const intent = normalizeToolIntent({
      intentId: "intent-1",
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      stateId: "chat:call-1",
      toolId: toolName,
      toolVersion: mcp.serverRevision,
      action: "integration.execute",
      targetRefs: [{ type: "integration", id: mcp.serverId }],
      arguments: args,
      filePrincipalId: "user-1",
      fileIds: ["file-1"],
      agentPrincipalId: "agent-1",
      principalKind: "user",
      principalId: "user-1",
      destination: "https://api.acme.test",
      mcp,
      idempotencyKey: "idempotency-1",
    });
    await approvals.decide({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      toolCallId: "call-1",
      toolName,
      args,
      requesterPrincipalId: "user:user-1",
      demand: {
        demandedBy: "guardrail_rule",
        guardrailRevision: "gr-1",
        reason: "approval_required",
      },
      intent,
    });

    const restarted = new ToolApprovalService({ transactions });
    await expect(
      restarted.findIntent({
        runId,
        toolCallId: "call-1",
        toolName,
        args,
      })
    ).resolves.toEqual(intent);
    const changedIntent = await restarted.decide({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      toolCallId: "call-1",
      toolName,
      args,
      requesterPrincipalId: "user:user-1",
      demand: {
        demandedBy: "guardrail_rule",
        guardrailRevision: "gr-1",
        reason: "approval_required",
      },
      intent: { ...intent, destination: "https://redirected.example" },
    });
    expect(changedIntent.status).toBe("pending");
    if (changedIntent.status !== "pending") throw new Error("expected replacement approval");
    expect(await repo.findById(changedIntent.approvalId)).toMatchObject({
      payload: {
        intent: { destination: "https://redirected.example" },
      },
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
        requesterPrincipalId: "user:requester-1",
        demand: {
          demandedBy: "guardrail_rule",
          guardrailRevision: "gr-1",
          reason: "approval_required",
          ruleId: "rule-1",
        },
      })
    ).toEqual({ status: "approved", approvalId });

    expect((await repo.listPending("tool_call")).length).toBe(0);
  });

  it("supersedes an approval when the live Guardrail revision changes", async () => {
    const runId = await startRunningRun();
    const { approvalId: oldApprovalId } = await requestApproval(runId, "call-1");
    await park(runId, oldApprovalId);
    await approvals.signal({
      businessId: DEPLOYMENT_BUSINESS_ID,
      approvalId: oldApprovalId,
      decision: "approved",
      principal: PRINCIPAL,
    });
    await resumeRunning(runId);

    const changedRevision = await approvals.decide({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      toolCallId: "call-2",
      toolName: "record_delete",
      args: { id: "record-1" },
      requesterPrincipalId: "user:requester-1",
      demand: {
        demandedBy: "guardrail_rule",
        guardrailRevision: "gr-2",
        reason: "approval_required",
        ruleId: "rule-1",
      },
    });
    expect(changedRevision.status).toBe("pending");
    if (changedRevision.status !== "pending") throw new Error("expected replacement approval");
    expect(changedRevision.approvalId).not.toBe(oldApprovalId);
    expect(await repo.findById(oldApprovalId)).toMatchObject({
      status: "approved",
      payload: { approvalBindingSuperseded: true },
    });
    expect(await approvals.consume({ approvalId: oldApprovalId, toolCallId: "call-2" })).toBe(
      false
    );

    await park(runId, changedRevision.approvalId);
    await approvals.signal({
      businessId: DEPLOYMENT_BUSINESS_ID,
      approvalId: changedRevision.approvalId,
      decision: "approved",
      principal: PRINCIPAL,
    });

    expect(
      await approvals.decide({
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId,
        toolCallId: "call-3",
        toolName: "record_delete",
        args: { id: "record-1" },
        requesterPrincipalId: "user:requester-1",
        demand: {
          demandedBy: "guardrail_rule",
          guardrailRevision: "gr-2",
          reason: "approval_required",
          ruleId: "rule-1",
        },
      })
    ).toEqual({ status: "approved", approvalId: changedRevision.approvalId });
    expect(
      await approvals.consume({
        approvalId: changedRevision.approvalId,
        toolCallId: "call-3",
      })
    ).toBe(true);
  });

  it("serializes concurrent first creation and stale-binding replacement", async () => {
    const decide = (
      service: ToolApprovalService,
      runId: string,
      guardrailRevision: string,
      toolCallId: string
    ) =>
      service.decide({
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId,
        toolCallId,
        toolName: "record_delete",
        args: { id: "record-1" },
        requesterPrincipalId: "user:requester-1",
        demand: {
          demandedBy: "guardrail_rule",
          guardrailRevision,
          reason: "approval_required",
          ruleId: "rule-1",
        },
      });

    const firstRunId = await startRunningRun("concurrent-first");
    const firstCreationService = new ToolApprovalService({
      transactions: concurrentApprovalTransactions(),
    });
    const [firstCreation, duplicateCreation] = await Promise.all([
      decide(firstCreationService, firstRunId, "gr-1", "call-1"),
      decide(firstCreationService, firstRunId, "gr-1", "call-2"),
    ]);
    expect(firstCreation.status).toBe("pending");
    expect(duplicateCreation).toEqual(firstCreation);
    const firstRows = await db.query<{ active: string }>(
      `SELECT COUNT(*)::text AS active
       FROM approvals
       WHERE payload->>'runId' = $1
         AND payload->>'approvalBindingSuperseded' IS DISTINCT FROM 'true'`,
      [firstRunId]
    );
    expect(Number(firstRows.rows[0]?.active ?? "0")).toBe(1);

    const runId = await startRunningRun("concurrent-replacement");
    const { approvalId: oldApprovalId } = await requestApproval(runId, "call-1");
    expect(await repo.settlePending(oldApprovalId, "approved")).toBe(true);
    const replacementService = new ToolApprovalService({
      transactions: concurrentApprovalTransactions(),
    });
    const [first, second] = await Promise.all([
      decide(replacementService, runId, "gr-2", "call-2"),
      decide(replacementService, runId, "gr-2", "call-3"),
    ]);
    expect(first.status).toBe("pending");
    expect(second).toEqual(first);
    if (first.status !== "pending") throw new Error("expected replacement approval");

    const { rows } = await db.query<{ active: string }>(
      `SELECT COUNT(*)::text AS active
       FROM approvals
       WHERE payload->>'runId' = $1
         AND payload->>'approvalBindingSuperseded' IS DISTINCT FROM 'true'`,
      [runId]
    );
    expect(Number(rows[0]?.active ?? "0")).toBe(1);
    expect(await approvals.consume({ approvalId: oldApprovalId, toolCallId: "call-2" })).toBe(
      false
    );

    expect(await repo.settlePending(first.approvalId, "approved")).toBe(true);
    expect(await approvals.consume({ approvalId: first.approvalId, toolCallId: "call-2" })).toBe(
      true
    );
    expect(await approvals.consume({ approvalId: first.approvalId, toolCallId: "call-3" })).toBe(
      false
    );
  });

  it("supersedes an approval when its demand evidence changes", async () => {
    const runId = await startRunningRun();
    const { approvalId: oldApprovalId } = await requestApproval(runId, "call-1");
    expect(await repo.settlePending(oldApprovalId, "approved")).toBe(true);

    const changedDemand = await approvals.decide({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      toolCallId: "call-2",
      toolName: "record_delete",
      args: { id: "record-1" },
      requesterPrincipalId: "user:requester-1",
      demand: {
        demandedBy: "guardrail_rule",
        guardrailRevision: "gr-1",
        reason: "sensitive_destination",
        ruleId: "rule-1",
      },
    });

    expect(changedDemand.status).toBe("pending");
    if (changedDemand.status !== "pending") throw new Error("expected replacement approval");
    expect(changedDemand.approvalId).not.toBe(oldApprovalId);
    expect(await repo.findById(oldApprovalId)).toMatchObject({
      status: "approved",
      payload: { approvalBindingSuperseded: true },
    });
    expect(await approvals.consume({ approvalId: oldApprovalId, toolCallId: "call-2" })).toBe(
      false
    );
  });

  it("asks again for a second identical call once the approved one has been spent", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId, "call-1");
    await park(runId, approvalId);
    await approvals.signal({
      businessId: DEPLOYMENT_BUSINESS_ID,
      approvalId,
      decision: "approved",
      principal: PRINCIPAL,
    });

    // The dispatch that will execute spends the decision, keyed to its own call id.
    expect(await approvals.consume({ approvalId, toolCallId: "call-1" })).toBe(true);
    // A redelivery of that same dispatch is one authorized call, not two.
    expect(await approvals.consume({ approvalId, toolCallId: "call-1" })).toBe(true);
    // Another call cannot take it.
    expect(await approvals.consume({ approvalId, toolCallId: "call-2" })).toBe(false);

    // The same intent again is a new question for a human, not a silent repeat.
    const repeat = await approvals.decide({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      toolCallId: "call-2",
      toolName: "record_delete",
      args: { id: "record-1" },
      requesterPrincipalId: "user:requester-1",
      demand: {
        demandedBy: "guardrail_rule",
        guardrailRevision: "gr-1",
        reason: "approval_required",
        ruleId: "rule-1",
      },
    });
    expect(repeat.status).toBe("pending");
    expect(repeat).not.toMatchObject({ approvalId });

    // …while the call that spent it still resolves to the decision it was given, so a redelivered
    // dispatch of the approved call performs the approved work rather than parking again.
    expect(
      await approvals.decide({
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId,
        toolCallId: "call-1",
        toolName: "record_delete",
        args: { id: "record-1" },
        requesterPrincipalId: "user:requester-1",
        demand: {
          demandedBy: "guardrail_rule",
          guardrailRevision: "gr-1",
          reason: "approval_required",
          ruleId: "rule-1",
        },
      })
    ).toEqual({ status: "approved", approvalId });
  });

  it("fails closed and replaces an approval with malformed persisted binding evidence", async () => {
    const runId = await startRunningRun();
    const { approvalId: oldApprovalId } = await requestApproval(runId, "call-1");
    expect(await repo.settlePending(oldApprovalId, "approved")).toBe(true);
    await repo.mergePayload(oldApprovalId, { intentDigest: "tampered-intent-digest" });

    const replacement = await approvals.decide({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      toolCallId: "call-2",
      toolName: "record_delete",
      args: { id: "record-1" },
      requesterPrincipalId: "user:requester-1",
      demand: {
        demandedBy: "guardrail_rule",
        guardrailRevision: "gr-1",
        reason: "approval_required",
        ruleId: "rule-1",
      },
    });

    expect(replacement.status).toBe("pending");
    if (replacement.status !== "pending") throw new Error("expected replacement approval");
    expect(replacement.approvalId).not.toBe(oldApprovalId);
    expect(await repo.findById(oldApprovalId)).toMatchObject({
      status: "approved",
      payload: { approvalBindingSuperseded: true },
    });
    expect(await approvals.consume({ approvalId: oldApprovalId, toolCallId: "call-2" })).toBe(
      false
    );
  });

  it("never lets a denial be spent, so a retry keeps getting the same no", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId, "call-1");
    await park(runId, approvalId);
    await approvals.signal({
      businessId: DEPLOYMENT_BUSINESS_ID,
      approvalId,
      decision: "denied",
      principal: PRINCIPAL,
    });

    expect(await approvals.consume({ approvalId, toolCallId: "call-1" })).toBe(false);
    expect(
      await approvals.decide({
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId,
        toolCallId: "call-2",
        toolName: "record_delete",
        args: { id: "record-1" },
        requesterPrincipalId: "user:requester-1",
        demand: {
          demandedBy: "guardrail_rule",
          guardrailRevision: "gr-1",
          reason: "approval_required",
          ruleId: "rule-1",
        },
      })
    ).toEqual({ status: "denied", reason: "denied by operator" });
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
      requesterPrincipalId: "user:requester-1",
      demand: {
        demandedBy: "guardrail_rule",
        guardrailRevision: "gr-1",
        reason: "approval_required",
        ruleId: "rule-1",
      },
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
        requesterPrincipalId: "user:requester-1",
        demand: {
          demandedBy: "guardrail_rule",
          guardrailRevision: "gr-1",
          reason: "approval_required",
          ruleId: "rule-1",
        },
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

  it("rolls back the decision and wait signal when requeueing the Run fails", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);
    const { waitId } = await park(runId, approvalId);

    const failingTransactions: TransactionPort = {
      withTransaction: (operation) =>
        db.transaction((transaction) =>
          operation({
            query: async (text, params) => {
              if (text.includes("UPDATE runs") && text.includes("status = 'queued'")) {
                throw new Error("requeue unavailable");
              }
              return (transaction as unknown as Queryable).query(text, params);
            },
          } as Queryable)
        ),
    };
    const restarted = new ToolApprovalService({ transactions: failingTransactions });

    await expect(
      restarted.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: PRINCIPAL,
      })
    ).rejects.toThrow("requeue unavailable");

    expect(await repo.findById(approvalId)).toMatchObject({ status: "pending" });
    expect(
      await new DurableWaitManager(new WaitStore(transactions), new RunResumeGateway(runs)).find(
        DEPLOYMENT_BUSINESS_ID,
        waitId
      )
    ).toMatchObject({ status: "pending" });
    const { rows } = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM run_wait_signals WHERE wait_id = $1",
      [waitId]
    );
    expect(Number(rows[0]?.count ?? "0")).toBe(0);
  });

  it("recovers a settled legacy decision after restart without inventing an approver", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);
    await park(runId, approvalId);
    expect(await repo.settlePending(approvalId, "approved")).toBe(true);

    const restarted = new ToolApprovalService({ transactions });
    expect(
      await restarted.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: PRINCIPAL,
      })
    ).toBe("resumed");

    expect(await repo.findById(approvalId)).toMatchObject({
      status: "approved",
      approverPrincipalId: null,
    });
    const { rows } = await db.query<{ signal_digest: string }>(
      `SELECT signal_digest
       FROM run_wait_signals
       WHERE correlation_key = $1`,
      [`approval:${approvalId}`]
    );
    expect(rows[0]?.signal_digest).toBe(
      canonicalHash({ approvalId, decision: "approved", decidedBy: null })
    );
    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({ status: "queued" });
  });

  it("does not signal a conflicting retry of a settled decision", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);
    const { waitId } = await park(runId, approvalId);
    expect(await repo.settlePending(approvalId, "approved", "user:original-approver")).toBe(true);

    expect(
      await new ToolApprovalService({ transactions }).signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "denied",
        principal: PRINCIPAL,
      })
    ).toBe("already_settled");

    expect(await repo.findById(approvalId)).toMatchObject({
      status: "approved",
      approverPrincipalId: "user:original-approver",
    });
    expect(
      await new DurableWaitManager(new WaitStore(transactions), new RunResumeGateway(runs)).find(
        DEPLOYMENT_BUSINESS_ID,
        waitId
      )
    ).toMatchObject({ status: "pending" });
    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({ status: "waiting" });
  });

  it("recovers when the signal landed before the Run parked", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);
    await approvals.registerWait({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      stateKey: STATE_KEY,
      approvalId,
      subject: SUBJECT,
    });

    expect(
      await approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: PRINCIPAL,
      })
    ).toBe("resumed");

    await park(runId, approvalId);
    expect(
      await new ToolApprovalService({ transactions }).signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: PRINCIPAL,
      })
    ).toBe("resumed");
    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({ status: "queued" });
  });

  it("does not wake a Run that acquired a newer pending wait", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);
    await approvals.registerWait({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      stateKey: STATE_KEY,
      approvalId,
      subject: SUBJECT,
    });
    await approvals.signal({
      businessId: DEPLOYMENT_BUSINESS_ID,
      approvalId,
      decision: "approved",
      principal: PRINCIPAL,
    });
    await park(runId, approvalId);

    await new DurableWaitManager(new WaitStore(transactions), new RunResumeGateway(runs)).register({
      id: "99999999-9999-4999-8999-999999999999",
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      stateKey: STATE_KEY,
      kind: "human_task",
      aggregation: "first",
      schemaRef: "test.newer-wait.v1",
      allowedPrincipals: [PRINCIPAL],
      expectedSignals: 1,
      quorum: null,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    expect(
      await new ToolApprovalService({ transactions }).signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: PRINCIPAL,
      })
    ).toBe("resumed");
    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({ status: "waiting" });
  });

  it("rolls back a decision when the wait token is invalid", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);
    await park(runId, approvalId);
    await repo.mergePayload(approvalId, { resumeToken: "not-the-resume-token" });

    await expect(
      approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: PRINCIPAL,
      })
    ).rejects.toEqual(expect.objectContaining({ code: "unknown_resume_token" }));
    expect(await repo.findById(approvalId)).toMatchObject({ status: "pending" });
  });

  it("rolls back a decision when the approval wait expired", async () => {
    let now = new Date("2026-09-07T10:00:00.000Z");
    approvals = new ToolApprovalService({
      transactions,
      now: () => now,
      ttlMs: 1_000,
    });
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);
    await park(runId, approvalId);
    now = new Date("2026-09-07T10:00:01.000Z");

    await expect(
      approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: PRINCIPAL,
      })
    ).rejects.toBeInstanceOf(DurableWaitError);
    expect(await repo.findById(approvalId)).toMatchObject({ status: "pending" });
  });

  it("settles an expired pending approval once instead of opening another wait", async () => {
    let now = new Date("2026-09-07T10:00:00.000Z");
    approvals = new ToolApprovalService({
      transactions,
      now: () => now,
      ttlMs: 1_000,
    });
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);
    now = new Date("2026-09-07T10:00:01.000Z");

    const retried = await approvals.decide({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      toolCallId: "call-1",
      toolName: "record_delete",
      args: { id: "record-1" },
      requesterPrincipalId: "user:requester-1",
      demand: {
        demandedBy: "guardrail_rule",
        guardrailRevision: "gr-1",
        reason: "approval_required",
        ruleId: "rule-1",
      },
    });

    expect(retried).toEqual({ status: "denied", reason: "approval request timed out" });
    expect(await repo.findById(approvalId)).toMatchObject({ status: "timeout" });
    const { rows } = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM approvals WHERE payload->>'runId' = $1",
      [runId]
    );
    expect(Number(rows[0]?.count ?? "0")).toBe(1);
  });

  it("never requeues a cancelled Run when an approval arrives late", async () => {
    const runId = await startRunningRun();
    const { approvalId } = await requestApproval(runId);
    await park(runId, approvalId);
    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, runId, {
      expectedVersion: 3,
      expectedStatus: "waiting",
      status: "cancelling",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, runId, {
      expectedVersion: 4,
      expectedStatus: "cancelling",
      status: "cancelled",
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    expect(
      await approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: PRINCIPAL,
      })
    ).toBe("resumed");
    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({ status: "cancelled" });

    await approvals.signal({
      businessId: DEPLOYMENT_BUSINESS_ID,
      approvalId,
      decision: "approved",
      principal: PRINCIPAL,
    });
    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({ status: "cancelled" });
  });
});
