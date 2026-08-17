import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgConversationStore } from "../apps/api/src/conversations/store.pg";
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
  ModelMessage,
  ModelPort,
} from "../packages/agent-runtime/src/ports";
import { DEPLOYMENT_BUSINESS_ID } from "../packages/constants/src/index";
import type { Queryable as StorageQueryable, TransactionPort } from "../packages/storage/src/ports";
import { RunLoopCheckpointStore } from "../packages/storage/src/runs/loop-checkpoint-store";
import { RunStore, type StartRunInput } from "../packages/storage/src/runs/run-store";
import { ApprovalsRepo } from "../packages/tool-host/src/approvals/repo";
import { ToolApprovalService } from "../packages/tool-host/src/approvals/tool-approvals";

/**
 * Fitness function for L4-6: a Turn that parks on an approval must resume with the transcript it
 * built, and must complete the approved work exactly once.
 *
 * The Agent loop's transcript used to live only in `AgentLoop.run()`'s local `messages[]`, which
 * dies with the call. Counters were checkpointed; the transcript was not, and the message store
 * deliberately persists text messages only. A resumed Turn therefore had no record that any Tool
 * call had happened — including the one the user had just approved — while still being charged
 * for the calls it could no longer see. This test drives the production pieces (the real loop,
 * the real durable checkpoint store on PostgreSQL, and the real intent-keyed approval service)
 * across a park and a resume, and asserts what unit tests on the pieces cannot: the read is not
 * re-run, the approved effect lands once, the counters match the work, and none of it leaks into
 * the participant-visible conversation history.
 */

const RUN_ID = "00000000-0000-4000-8000-0000000000a1";
const CONVERSATION_ID = "00000000-0000-4000-8000-0000000000a2";
const TURN_ID = "00000000-0000-4000-8000-0000000000a3";
const USER_ID = "00000000-0000-4000-8000-0000000000a4";
/** Every approval records who asked and what demanded a human; the table requires both (I-13). */
const APPROVAL_REQUESTER = `user:${USER_ID}`;
const APPROVAL_DEMAND = {
  demandedBy: "autonomy_policy",
  guardrailRevision: "none",
  reason: "autonomy_requires_approval",
} as const;
const MESSAGE_ID = "00000000-0000-4000-8000-0000000000a5";
const STATE_KEY = "invoke";
const CREATED_AT = new Date("2026-08-16T00:00:00.000Z");

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

const READ_TOOL = "crm.customer.search";
const WRITE_TOOL = "crm.customer.update";

/** The tools the Turn exposes: one read that batches, one write that needs an approval. */
const TOOLS = [
  { name: READ_TOOL, inputSchema: { type: "object" }, mutating: false },
  { name: WRITE_TOOL, inputSchema: { type: "object" }, mutating: true },
];

const WRITE_ARGS = { id: "cust-1", tier: "gold" };

/** Model output shapes, spelled out so a scripted turn reads like the transcript it produces. */
function toolCall(callId: string, name: string, args: unknown): ModelInvocationResult {
  return {
    requestId: "req",
    output: { kind: "tool_calls", calls: [{ callId, name, arguments: args }] },
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function finalText(text: string): ModelInvocationResult {
  return {
    requestId: "req",
    output: { kind: "text", text },
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

/** Records every prompt it is given, so the resumed transcript can be inspected. */
class ScriptedModel implements ModelPort {
  readonly prompts: ModelMessage[][] = [];

  constructor(private readonly script: ModelInvocationResult[]) {}

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    this.prompts.push([...request.messages]);
    const next = this.script.shift();
    if (next === undefined)
      throw new Error("the model was called more times than the test scripted");
    return next;
  }
}

/**
 * Mirrors the production dispatcher's ordering for the one property under test: an approval is
 * decided *before* the Tool executes, so a parked call performs no effect. Executions are counted
 * so "exactly once" is measured, not assumed.
 */
function dispatcher(approvals: ToolApprovalService): ToolDispatchPort & {
  readonly executed: string[];
} {
  const executed: string[] = [];
  return {
    executed,
    dispatch: async (request: ToolDispatchRequest): Promise<ToolDispatchResult> => {
      if (request.name === WRITE_TOOL) {
        const decision = await approvals.decide({
          businessId: request.businessId,
          runId: request.runId,
          toolCallId: request.callId,
          toolName: request.name,
          args: request.arguments,
          requesterPrincipalId: APPROVAL_REQUESTER,
          demand: APPROVAL_DEMAND,
        });
        if (decision.status === "pending") {
          return {
            status: "awaiting_approval",
            callId: request.callId,
            approvalId: decision.approvalId,
          };
        }
        if (decision.status === "denied") {
          return { status: "denied", callId: request.callId, reason: decision.reason };
        }
      }
      executed.push(request.name);
      return {
        status: "succeeded",
        callId: request.callId,
        output: request.name === READ_TOOL ? { customers: ["cust-1"] } : { updated: true },
      };
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
    messages: [{ role: "user", content: "upgrade cust-1 to gold" }],
    tools: TOOLS,
    limits: { maxIterations: 8, maxToolCalls: 4, maxRepairAttempts: 2 },
  };
}

describe("approval park/resume transcript durability (L4-6)", () => {
  let database: PGlite;
  let checkpoints: RunLoopCheckpointStore;
  let approvals: ToolApprovalService;
  let repo: ApprovalsRepo;

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
    approvals = new ToolApprovalService({ repo, waits: unusedWaits() });
  });

  afterEach(async () => {
    await database.close();
  });

  /** The wait manager belongs to the resume path, not the decision path this test drives. */
  function unusedWaits() {
    return {
      register: async () => {
        throw new Error("this test approves through the repo, not the durable wait");
      },
    } as never;
  }

  /** Runs one `AgentLoop.run` against the durable checkpoint store, as an executor would. */
  async function runLoop(model: ModelPort, tools: ToolDispatchPort) {
    return new AgentLoop({
      model,
      tools,
      checkpoints,
      events: { append: async () => {} },
      budget: { consume: async () => ({ outcome: "ok" }) },
      isCancelled: async () => false,
    }).run(loopInput());
  }

  it("resumes with the transcript it built and performs the approved work exactly once", async () => {
    const tools = dispatcher(approvals);

    // Attempt 1: a read lands, then the write parks the Turn on an approval.
    const first = new ScriptedModel([
      toolCall("c1", READ_TOOL, { query: "cust-1" }),
      toolCall("c2", WRITE_TOOL, WRITE_ARGS),
    ]);
    const parked = await runLoop(first, tools);

    expect(parked).toMatchObject({ status: "awaiting_approval", callId: "c2" });
    expect(tools.executed).toEqual([READ_TOOL]);
    // The parked call never ran, so it is not charged; only the read is.
    expect(parked).toMatchObject({ toolCalls: 1 });

    const approvalId = (parked as { approvalId: string }).approvalId;
    expect(await repo.settlePending(approvalId, "approved")).toBe(true);

    // Attempt 2: the same State re-enters the loop, exactly as the chat executor re-enters it.
    const second = new ScriptedModel([finalText("cust-1 is now gold.")]);
    const resumed = await runLoop(second, tools);

    expect(resumed).toMatchObject({ status: "completed", output: "cust-1 is now gold." });

    // The approved effect landed once, and the read was not re-run to rediscover it.
    expect(tools.executed).toEqual([READ_TOOL, WRITE_TOOL]);

    // Two Tool calls happened across the whole Turn and two were charged — the park refunded the
    // call it did not make rather than charging it twice.
    expect(resumed).toMatchObject({ toolCalls: 2 });

    // The resumed model was given the transcript, not amnesia: it saw its own proposed calls and
    // both results, including the one produced after the approval.
    const resumedPrompt = second.prompts.at(0) ?? [];
    const transcript = resumedPrompt.map((message) => message.content).join("\n");
    expect(transcript).toContain(READ_TOOL);
    expect(transcript).toContain("cust-1");
    expect(transcript).toContain('"updated":true');
    expect(resumedPrompt.filter((message) => message.role === "tool")).toHaveLength(2);

    // A settled loop keeps its counters and drops the transcript it no longer owes anyone.
    const settled = await database.query<{ resume_state: unknown; tool_calls: string }>(
      "SELECT resume_state, tool_calls FROM agent_loop_checkpoints WHERE run_id = $1",
      [RUN_ID]
    );
    expect(settled.rows[0]?.resume_state).toBeNull();
    expect(Number(settled.rows[0]?.tool_calls)).toBe(2);
  });

  it("keeps the model transcript out of the participant-visible chat history", async () => {
    const store = new PgConversationStore(database as unknown as Queryable);
    await store.appendMessage({
      id: MESSAGE_ID,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      role: "user",
      content: "upgrade cust-1 to gold",
      createdAt: CREATED_AT,
    });
    await store.saveTurn({
      id: TURN_ID,
      businessId: DEPLOYMENT_BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      idempotencyKey: "client-key-1",
      requestMessageId: MESSAGE_ID,
      status: "pending",
      attempt: 1,
      runId: RUN_ID,
      cursor: 0,
      supersededRunIds: [],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });

    const tools = dispatcher(approvals);
    await runLoop(
      new ScriptedModel([
        toolCall("c1", READ_TOOL, { query: "cust-1" }),
        toolCall("c2", WRITE_TOOL, WRITE_ARGS),
      ]),
      tools
    );

    // The parked transcript is durable…
    const parked = await database.query<{ resume_state: { messages: ModelMessage[] } }>(
      "SELECT resume_state FROM agent_loop_checkpoints WHERE run_id = $1",
      [RUN_ID]
    );
    expect(JSON.stringify(parked.rows[0]?.resume_state)).toContain(READ_TOOL);

    // …and none of it reached the conversation a user reads.
    const visible = await store.listMessages(DEPLOYMENT_BUSINESS_ID, CONVERSATION_ID);
    expect(visible.map((message) => message.content)).toEqual(["upgrade cust-1 to gold"]);
    const messages = await database.query<{ count: string }>("SELECT count(*) FROM messages");
    expect(Number(messages.rows[0]?.count)).toBe(1);
  });
});
