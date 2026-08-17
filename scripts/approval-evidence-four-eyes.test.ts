import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ambientTransactionPort, type Queryable, transactionPort } from "../apps/api/src/db";
import { makeMigratedPglite } from "../apps/api/src/test/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "../packages/constants/src/index";
import {
  ArtifactService,
  DurableInvocationGateway,
  DurableWaitManager,
  PgDurableInvocationStore,
  RunResumeGateway,
  TypedOutputValidator,
} from "../packages/run-kernel/src/index";
import { CHAT_REQUEST_SCHEMA_REF, INVOCATION_REQUEST_SCHEMAS } from "../packages/schema/src/index";
import { ArtifactStore } from "../packages/storage/src/artifacts/artifact-store";
import { RunStore } from "../packages/storage/src/runs/run-store";
import { WaitStore } from "../packages/storage/src/runs/wait-store";
import {
  type ApprovalGuardrailEvidence,
  approvalEvidenceDigest,
  readApprovalEvidence,
} from "../packages/tool-host/src/approvals/evidence";
import { ApprovalsRepo } from "../packages/tool-host/src/approvals/repo";
import { ToolApprovalService } from "../packages/tool-host/src/approvals/tool-approvals";
import type { TurnAuthority } from "../packages/tool-host/src/authority";
import { InMemoryToolCatalog } from "../packages/tool-host/src/catalog";
import { defineApiTool, toToolDef } from "../packages/tool-host/src/define";
import { RegistryToolDispatcher } from "../packages/tool-host/src/dispatcher";
import type { ToolGate } from "../packages/tool-host/src/gate";
import { ok, type ToolDef } from "../packages/tool-host/src/types";

/**
 * Fitness function for L6-7, the residual half of LB-11 against invariant I-13.
 *
 * Two properties were missing after the one-use half landed, and both are properties of the
 * *composition*, not of a method: an approval could be created carrying no record of the policy
 * evaluation that demanded it, and the principal who asked for an effect could authorize it.
 * Neither had anything standing over the production wiring, which is why LB-11 stayed open while
 * the digest binding beside it was already enforced.
 *
 * So this drives the real pieces — `RegistryToolDispatcher`, `ToolApprovalService`, the real
 * `DurableWaitManager` over a migrated PostgreSQL — from the dispatch that asks for a human to the
 * request that decides, and asserts:
 *
 *  1. Every approval the composition creates carries the Guardrail evidence that demanded it,
 *     bound to the intent and content-addressed, and names the principal that requested it.
 *  2. The table refuses an approval without that evidence and refuses to let it change afterwards,
 *     so the record proves what the approver was shown rather than merely asserting it.
 *  3. A requester cannot decide their own approval while any other principal could decide it, and
 *     the one principal in a solo deployment still can — a four-eyes rule that bricks a
 *     single-admin instance is a worse failure than the self-approval it prevents.
 */

const SUBJECT = { kind: "user", id: "11111111-1111-4111-8111-111111111111" } as const;
const REQUESTER = `${SUBJECT.kind}:${SUBJECT.id}`;
const APPROVER_ID = "22222222-2222-4222-8222-222222222222";
const STATE_KEY = "invoke";
const WRITE_TOOL = "customer_delete";
const WRITE_ARGS = { id: "cust-1" };

/** A gate that demands a human and attributes it, as `authorizeToolIntent` does. */
const RULE_GATE: ToolGate = {
  authorize: () => ({
    outcome: "awaiting_approval",
    demand: { requiredBy: "guardrail_rule", reason: "approval_required", ruleId: "no-bulk-delete" },
  }),
};

describe("approvals bind Guardrail evidence and enforce four eyes (L6-7)", () => {
  let database: PGlite;
  let runs: RunStore;
  let repo: ApprovalsRepo;
  let approvals: ToolApprovalService;
  let waits: DurableWaitManager;
  let invocations: DurableInvocationGateway;
  let executed: unknown[];

  beforeEach(async () => {
    database = await makeMigratedPglite();
    const queryable = database as unknown as Queryable;
    const transactions = transactionPort(queryable);
    const validator = new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS);
    invocations = new DurableInvocationGateway({
      store: new PgDurableInvocationStore(
        transactions,
        (transaction) =>
          new ArtifactService(new ArtifactStore(ambientTransactionPort(transaction)), validator)
      ),
      validator,
    });
    runs = new RunStore(transactions);
    repo = new ApprovalsRepo(queryable);
    waits = new DurableWaitManager(new WaitStore(transactions), new RunResumeGateway(runs));
    approvals = new ToolApprovalService({ repo, waits });
    executed = [];
    await addUser(SUBJECT.id, "requester@example.com", "admin");
  });

  afterEach(async () => {
    await database.close();
  });

  async function addUser(id: string, email: string, role: string): Promise<void> {
    await database.query(
      `INSERT INTO users (id, email, password_hash, role, created_at, status)
       VALUES ($1, $2, 'x', $3, now(), 'active')`,
      [id, email, role]
    );
  }

  function dispatcher(gate?: ToolGate): RegistryToolDispatcher {
    const registry = new InMemoryToolCatalog();
    const schema = {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string" } },
    };
    const run = async (args: unknown) => {
      executed.push(args);
      return ok({ deleted: true });
    };
    // A gated dispatch needs the authorization contract the gate decides against; the ungated one
    // is the plain registry Tool the autonomy path sees.
    const definition: ToolDef =
      gate === undefined
        ? {
            name: WRITE_TOOL,
            tier: "platform",
            mutating: true,
            description: "deletes a customer",
            inputSchema: schema,
            execute: run,
          }
        : toToolDef(
            defineApiTool({
              name: WRITE_TOOL,
              tier: "platform",
              mutating: true,
              description: "deletes a customer",
              inputSchema: schema as unknown as Record<string, unknown>,
              authorization: {
                action: "record.delete",
                resources: ["record"],
                dataClasses: ["business_record"],
              },
              handler: run,
            }),
            (context) => context
          );
    registry.register(definition);
    return new RegistryToolDispatcher({
      registry,
      // The Turn asked to be supervised; that is what makes this Tool need a human at all.
      artifacts: {
        read: async () => ({ content: { autonomy: "approval-required" } }),
      } as unknown as ArtifactService,
      approvals,
      ...(gate === undefined
        ? {}
        : {
            gate,
            authorityLayers: {
              resolvePrincipalLayer: async (name: string) => ({ name, grants: [] }),
            },
          }),
    });
  }

  /** Mints a chat Run and drives it to `running`, where a turn asks for an approval. */
  async function startRunningRun(): Promise<string> {
    const started = await invocations.start({
      source: "chat",
      runSource: "chat",
      businessId: DEPLOYMENT_BUSINESS_ID,
      initiator: SUBJECT,
      effectiveSubject: SUBJECT,
      definitionRef: "published:agent:assistant",
      payload: {
        conversationId: "conversation-1",
        message: { role: "user", content: "delete cust-1" },
        autonomy: "approval-required",
      },
      payloadSchemaRef: CHAT_REQUEST_SCHEMA_REF,
      idempotencyKey: "key-1",
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

  function authorityFor(runId: string): TurnAuthority {
    return {
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      turn: { id: "turn-1", conversationId: "conversation-1", attempt: 1 },
      subject: SUBJECT,
      source: "chat",
      bundleDigest: "sha256:bundle-1",
    };
  }

  /** The production ask: a real dispatch of a mutating Tool that a human has to authorize. */
  async function ask(runId: string, gate?: ToolGate): Promise<string> {
    const result = await dispatcher(gate).dispatch(authorityFor(runId), {
      callId: "c1",
      name: WRITE_TOOL,
      arguments: WRITE_ARGS,
    });
    if (result.status !== "awaiting_approval") {
      throw new Error(`expected the dispatch to ask for approval, got ${result.status}`);
    }
    expect(executed, "nothing may run before a human decides").toEqual([]);
    return result.approvalId;
  }

  /** What the Agent State runner does once the loop reports it parked. */
  async function park(runId: string, approvalId: string): Promise<void> {
    await approvals.registerWait({
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
  }

  async function evidenceOf(approvalId: string): Promise<ApprovalGuardrailEvidence> {
    const row = await repo.findById(approvalId);
    const evidence = readApprovalEvidence(row?.guardrailEvidence);
    if (evidence === null) throw new Error("the approval carries no Guardrail evidence at all");
    return evidence;
  }

  it("binds the evidence that demanded the approval to the approval it created", async () => {
    const runId = await startRunningRun();
    const approvalId = await ask(runId);

    const row = await repo.findById(approvalId);
    const evidence = await evidenceOf(approvalId);

    // The Turn's declared autonomy is what demanded a human here, and the record says so rather
    // than naming a Guardrail rule that never fired.
    expect(evidence.demandedBy).toBe("autonomy_policy");
    expect(evidence.reason).toBe("autonomy_requires_approval");
    expect(evidence.toolName).toBe(WRITE_TOOL);
    expect(evidence.intentDigest).toMatch(/^[a-z0-9:]+/);

    // Content-addressed, so a later substitution is detectable without trusting the row.
    expect(row?.guardrailEvidenceDigest).toBe(approvalEvidenceDigest(evidence));

    // And the approval knows who asked, which is the only thing four-eyes can be checked against.
    expect(row?.requesterPrincipalId).toBe(REQUESTER);
  });

  it("names the Guardrail rule when policy, not autonomy, demanded the human", async () => {
    const runId = await startRunningRun();
    const evidence = await evidenceOf(await ask(runId, RULE_GATE));

    expect(evidence.demandedBy).toBe("guardrail_rule");
    expect(evidence.ruleId).toBe("no-bulk-delete");
  });

  it("refuses to create a tool_call approval that carries no evidence", async () => {
    await expect(
      repo.insert({
        id: "33333333-3333-4333-8333-333333333333",
        kind: "tool_call",
        payload: { runId: "r-1", toolName: WRITE_TOOL },
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).rejects.toThrow(/approvals_tool_call_evidence/);
  });

  it("refuses to change the evidence an approval already recorded", async () => {
    const runId = await startRunningRun();
    const approvalId = await ask(runId);

    await expect(
      database.query("UPDATE approvals SET guardrail_evidence = $2 WHERE id = $1", [
        approvalId,
        JSON.stringify({ demandedBy: "autonomy_policy", reason: "something else" }),
      ])
    ).rejects.toThrow(/immutable Guardrail evidence/);
    await expect(
      database.query("UPDATE approvals SET requester_principal_id = $2 WHERE id = $1", [
        approvalId,
        `user:${APPROVER_ID}`,
      ])
    ).rejects.toThrow(/immutable Guardrail evidence/);
  });

  it("refuses the requester's own decision while another principal could decide", async () => {
    await addUser(APPROVER_ID, "approver@example.com", "member");
    const runId = await startRunningRun();
    const approvalId = await ask(runId);
    await park(runId, approvalId);

    expect(
      await approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: REQUESTER,
      }),
      "the principal that asked for the effect authorized it"
    ).toBe("forbidden");
    expect((await repo.findById(approvalId))?.status).toBe("pending");

    // The second pair of eyes decides, and the row records whose they were.
    expect(
      await approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: `user:${APPROVER_ID}`,
      })
    ).toBe("resumed");
    const settled = await repo.findById(approvalId);
    expect(settled?.status).toBe("approved");
    expect(settled?.approverPrincipalId).toBe(`user:${APPROVER_ID}`);
  });

  it("lets the only principal in a solo deployment decide, and records that it did", async () => {
    const runId = await startRunningRun();
    const approvalId = await ask(runId);
    await park(runId, approvalId);

    expect(
      await approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: REQUESTER,
      }),
      "a four-eyes rule that leaves a single-user deployment unable to decide anything is a bug"
    ).toBe("resumed");

    const settled = await repo.findById(approvalId);
    expect(settled?.status).toBe("approved");
    // Requester and approver are the same principal, so the exemption is visible afterwards.
    expect(settled?.approverPrincipalId).toBe(settled?.requesterPrincipalId);
  });

  it("refuses a decision on evidence that no longer matches what was recorded", async () => {
    await addUser(APPROVER_ID, "approver@example.com", "member");
    const runId = await startRunningRun();
    const approvalId = await ask(runId);
    await park(runId, approvalId);

    // Simulates evidence substituted past the trigger — a restored dump, a disabled trigger, a
    // migration run by hand. The decision path must not trust the row it is handed.
    await database.query("ALTER TABLE approvals DISABLE TRIGGER approvals_evidence_immutable");
    await database.query("UPDATE approvals SET guardrail_evidence = $2 WHERE id = $1", [
      approvalId,
      JSON.stringify({
        demandedBy: "autonomy_policy",
        guardrailRevision: "none",
        reason: "something the approver was never shown",
        toolName: WRITE_TOOL,
        intentDigest: "sha256:not-the-intent",
        demandedAt: "2026-08-16T00:00:00.000Z",
      }),
    ]);

    expect(
      await approvals.signal({
        businessId: DEPLOYMENT_BUSINESS_ID,
        approvalId,
        decision: "approved",
        principal: `user:${APPROVER_ID}`,
      })
    ).toBe("forbidden");
    expect((await repo.findById(approvalId))?.status).toBe("pending");
  });
});
