import type { PGlite } from "@electric-sql/pglite";
import type { ArtifactService } from "@tulipfarm/run-kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../apps/api/src/db";
import { makeMigratedPglite } from "../apps/api/src/test/pglite";
import type {
  AgentLoopInput,
  ToolDispatchPort,
  ToolDispatchRequest,
  ToolDispatchResult,
} from "../packages/agent-runtime/src/loop/contract";
import { AgentLoop } from "../packages/agent-runtime/src/loop/loop";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelPort,
} from "../packages/agent-runtime/src/ports";
import { DEPLOYMENT_BUSINESS_ID } from "../packages/constants/src/index";
import type { Queryable as StorageQueryable, TransactionPort } from "../packages/storage/src/ports";
import { RunLoopCheckpointStore } from "../packages/storage/src/runs/loop-checkpoint-store";
import { RunStore, type StartRunInput } from "../packages/storage/src/runs/run-store";
import { ApprovalsRepo } from "../packages/tool-host/src/approvals/repo";
import { ToolApprovalService } from "../packages/tool-host/src/approvals/tool-approvals";
import type { TurnAuthority } from "../packages/tool-host/src/authority";
import { InMemoryToolCatalog } from "../packages/tool-host/src/catalog";
import { RegistryToolDispatcher } from "../packages/tool-host/src/dispatcher";
import { ok, type ToolDef } from "../packages/tool-host/src/types";

/**
 * Fitness function for L6-6: one human approval authorizes one dispatch, not every identical
 * repeat for the rest of the Run.
 *
 * `ToolApprovalService.decide` used to answer `approved` for every byte-identical call in a Run
 * once any one of them had been approved, because the intent-keyed row had no consumed state and
 * no transition into one. A user who approved "delete customer X" once had silently approved
 * unlimited repeats of it — the exact reuse invariant I-13 forbids when it requires a decision to
 * be one-use.
 *
 * The fix cannot be "spend the decision when it is looked up": the L4-6 resume path replays the
 * parked call, and that replay's lookup is the one that must still find the approval. So this
 * drives the production pieces — the real `RegistryToolDispatcher`, the real intent-keyed
 * approval service on a migrated PostgreSQL, and the real `AgentLoop` with its durable checkpoint
 * store — across park, approve, resume, and a *second* identical proposal, and asserts both
 * halves at once: the approved call runs exactly once, and its twin has to ask again.
 */

const RUN_ID = "00000000-0000-4000-8000-0000000000b1";
const CONVERSATION_ID = "00000000-0000-4000-8000-0000000000b2";
const TURN_ID = "00000000-0000-4000-8000-0000000000b3";
const USER_ID = "00000000-0000-4000-8000-0000000000b4";
/** Every approval records who asked and what demanded a human; the table requires both (I-13). */
const APPROVAL_REQUESTER = `user:${USER_ID}`;
const APPROVAL_DEMAND = {
  demandedBy: "autonomy_policy",
  guardrailRevision: "none",
  reason: "autonomy_requires_approval",
} as const;
const STATE_KEY = "invoke";
const CREATED_AT = new Date("2026-08-16T00:00:00.000Z");

const WRITE_TOOL = "crm.customer.delete";
const WRITE_ARGS = { id: "cust-1" };

function startRun(): StartRunInput {
  return {
    id: RUN_ID,
    businessId: DEPLOYMENT_BUSINESS_ID,
    source: "chat",
    bundle: { digest: "sha256:bundle-1", routineId: "chat", routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: USER_ID },
      effectiveSubject: { kind: "user", id: USER_ID },
      guardrailContextRef: "guardrail-context-1",
    },
    createdAt: CREATED_AT.toISOString(),
    states: [
      { key: STATE_KEY, definitionRef: "sha256:bundle-1#/states/invoke", resolvedInput: {} },
    ],
  };
}

const AUTHORITY: TurnAuthority = {
  businessId: DEPLOYMENT_BUSINESS_ID,
  runId: RUN_ID,
  turn: { id: TURN_ID, conversationId: CONVERSATION_ID, attempt: 1 },
  subject: { kind: "user", id: USER_ID },
  source: "chat",
  bundleDigest: "sha256:bundle-1",
};

function toolCall(callId: string, args: unknown): ModelInvocationResult {
  return {
    requestId: "req",
    output: { kind: "tool_calls", calls: [{ callId, name: WRITE_TOOL, arguments: args }] },
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

class ScriptedModel implements ModelPort {
  constructor(private readonly script: ModelInvocationResult[]) {}

  async invoke(_request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    const next = this.script.shift();
    if (next === undefined)
      throw new Error("the model was called more times than the test scripted");
    return next;
  }
}

describe("one approval authorizes one dispatch (L6-6)", () => {
  let database: PGlite;
  let checkpoints: RunLoopCheckpointStore;
  let approvals: ToolApprovalService;
  let repo: ApprovalsRepo;
  let executed: unknown[];
  let tools: ToolDispatchPort;

  beforeEach(async () => {
    database = await makeMigratedPglite();
    const transactions: TransactionPort = {
      withTransaction: (operation) =>
        database.transaction((transaction) =>
          operation(transaction as unknown as StorageQueryable)
        ),
    };
    await new RunStore(transactions).start(startRun());
    await database.query(
      "INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES ($1, $2, $3, $3)",
      [CONVERSATION_ID, USER_ID, CREATED_AT]
    );
    checkpoints = new RunLoopCheckpointStore(transactions);
    repo = new ApprovalsRepo(database as unknown as { query: Queryable["query"] });
    approvals = new ToolApprovalService({
      repo,
      waits: {
        register: async () => {
          throw new Error("this test approves through the repo, not the durable wait");
        },
      } as never,
    });

    executed = [];
    const registry = new InMemoryToolCatalog();
    const definition: ToolDef = {
      name: WRITE_TOOL,
      tier: "platform",
      mutating: true,
      description: "deletes a customer",
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      execute: async (args) => {
        executed.push(args);
        return ok({ deleted: true });
      },
    };
    registry.register(definition);
    tools = toDispatchPort(
      new RegistryToolDispatcher({
        registry,
        // The Turn asked to be supervised; that is what makes this Tool need a human at all.
        artifacts: {
          read: async () => ({ content: { autonomy: "approval-required" } }),
        } as unknown as ArtifactService,
        approvals,
      })
    );
  });

  afterEach(async () => {
    await database.close();
  });

  /** The seam the Worker crosses in production, reduced to the mapping it performs. */
  function toDispatchPort(dispatcher: RegistryToolDispatcher): ToolDispatchPort {
    return {
      dispatch: async (request: ToolDispatchRequest): Promise<ToolDispatchResult> => {
        const result = await dispatcher.dispatch(AUTHORITY, {
          callId: request.callId,
          name: request.name,
          arguments: request.arguments,
        });
        return { ...result, callId: request.callId };
      },
    };
  }

  function loopInput(): AgentLoopInput {
    return {
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId: RUN_ID,
      stateId: STATE_KEY,
      modelProfileId: "profile-1",
      contextDigest: "sha256:context",
      guardrailDigest: "sha256:guardrail",
      messages: [{ role: "user", content: "delete cust-1" }],
      tools: [{ name: WRITE_TOOL, inputSchema: { type: "object" }, mutating: true }],
      limits: { maxIterations: 8, maxToolCalls: 4, maxRepairAttempts: 2 },
    };
  }

  async function runLoop(model: ModelPort) {
    return new AgentLoop({
      model,
      tools,
      checkpoints,
      events: { append: async () => {} },
      budget: { consume: async () => ({ outcome: "ok" }) },
      isCancelled: async () => false,
    }).run(loopInput());
  }

  async function approvalIds(): Promise<string[]> {
    const { rows } = await database.query<{ id: string }>(
      "SELECT id FROM approvals WHERE kind = 'tool_call' ORDER BY created_at, id"
    );
    return rows.map((row) => row.id);
  }

  it("performs the approved call once, then asks again for the identical repeat", async () => {
    // Attempt 1: the write parks the Turn. Nothing was executed, so nothing was approved yet.
    const parked = await runLoop(new ScriptedModel([toolCall("c1", WRITE_ARGS)]));
    expect(parked).toMatchObject({ status: "awaiting_approval", callId: "c1" });
    expect(executed).toEqual([]);

    const approvalId = (parked as { approvalId: string }).approvalId;
    expect(await repo.settlePending(approvalId, "approved")).toBe(true);

    // Attempt 2: the Turn resumes, replays the approved call — and the model, mid-loop, proposes
    // the very same delete a second time. The first must run; the second must ask.
    const resumed = await runLoop(new ScriptedModel([toolCall("c2", WRITE_ARGS)]));

    // The one approved deletion happened, exactly once.
    expect(executed).toEqual([WRITE_ARGS]);

    // The repeat did not ride it: the Turn parked again, on a *different*, brand-new approval.
    expect(resumed).toMatchObject({ status: "awaiting_approval", callId: "c2" });
    const second = (resumed as { approvalId: string }).approvalId;
    expect(second).not.toBe(approvalId);
    expect((await approvalIds()).sort()).toEqual([approvalId, second].sort());

    // And the human is being asked, not told after the fact.
    expect(await approvals.pendingForRun(RUN_ID)).toMatchObject({
      approvalId: second,
      toolName: WRITE_TOOL,
    });
  });

  it("keeps a spent decision spent across a process restart", async () => {
    const parked = await runLoop(new ScriptedModel([toolCall("c1", WRITE_ARGS)]));
    const approvalId = (parked as { approvalId: string }).approvalId;
    await repo.settlePending(approvalId, "approved");
    await runLoop(new ScriptedModel([toolCall("c2", WRITE_ARGS)]));
    expect(executed).toEqual([WRITE_ARGS]);

    // Everything in-memory is discarded; only PostgreSQL crosses the restart.
    const restarted = new ToolApprovalService({
      repo: new ApprovalsRepo(database as unknown as { query: Queryable["query"] }),
      waits: {} as never,
    });

    // The decision the surviving row records is spent, and stays spent for anyone else.
    expect(await restarted.consume({ approvalId, toolCallId: "c3" })).toBe(false);
    expect(
      await restarted.decide({
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId: RUN_ID,
        toolCallId: "c3",
        toolName: WRITE_TOOL,
        args: WRITE_ARGS,
        requesterPrincipalId: APPROVAL_REQUESTER,
        demand: APPROVAL_DEMAND,
      })
    ).toMatchObject({ status: "pending" });

    // The call that spent it still resolves to it, so a redelivered dispatch of the approved call
    // is one authorized effect rather than a second question.
    expect(
      await restarted.decide({
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId: RUN_ID,
        toolCallId: "c1",
        toolName: WRITE_TOOL,
        args: WRITE_ARGS,
        requesterPrincipalId: APPROVAL_REQUESTER,
        demand: APPROVAL_DEMAND,
      })
    ).toEqual({ status: "approved", approvalId });
  });

  it("lets exactly one of two calls racing for the same decision proceed", async () => {
    const parked = await runLoop(new ScriptedModel([toolCall("c1", WRITE_ARGS)]));
    const approvalId = (parked as { approvalId: string }).approvalId;
    await repo.settlePending(approvalId, "approved");

    const outcomes = await Promise.all([
      approvals.consume({ approvalId, toolCallId: "race-a" }),
      approvals.consume({ approvalId, toolCallId: "race-b" }),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });
});
