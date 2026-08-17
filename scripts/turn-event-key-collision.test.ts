import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../apps/api/src/db";
import { makeMigratedPglite } from "../apps/api/src/test/pglite";
import { TurnEventWriter } from "../apps/worker/src/turn/run-events";
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
  ModelStreamChunk,
} from "../packages/agent-runtime/src/ports";
import { DEPLOYMENT_BUSINESS_ID } from "../packages/constants/src/index";
import type { Queryable as StorageQueryable, TransactionPort } from "../packages/storage/src/ports";
import { RunEventStore } from "../packages/storage/src/runs/events";
import { RunLoopCheckpointStore } from "../packages/storage/src/runs/loop-checkpoint-store";
import { RunStore, type StartRunInput } from "../packages/storage/src/runs/run-store";
import { ApprovalsRepo } from "../packages/tool-host/src/approvals/repo";
import { ToolApprovalService } from "../packages/tool-host/src/approvals/tool-approvals";

/**
 * Fitness function for L4-7: a resumed Turn must not write a Run event under a key its earlier
 * pass already used.
 *
 * `TurnEventWriter` keys every event `${turnId}:${attempt}:${key}`, and a resumed Turn is the
 * *same* attempt — the chat executor rebuilds the writer from `findTurn()`, and a chat Turn mints
 * a fresh Run per attempt, so within the scope where uniqueness is actually enforced
 * (`UNIQUE (business_id, run_id, idempotency_key)`) the attempt segment is a constant and
 * discriminates nothing. The only thing separating a resumed loop event from the parked pass's is
 * the `loop:${sequence}` suffix, and that holds solely because `AgentLoop` reloads `sequence` and
 * `textIndex` from `agent_loop_checkpoints.resume_state` (L4-6) and counts on from there.
 *
 * That coupling is load-bearing and invisible: `RunEventStore.append` resolves a duplicate key with
 * `ON CONFLICT DO NOTHING` and hands back the *older* row, so a collision is a silently dropped
 * event and a cursor that walks backwards — never an error anyone would notice. Nothing but this
 * test holds it. Stop carrying the counters and the resumed answer stops reaching the participant
 * while every assertion inside the loop still passes.
 *
 * It drives the production pieces — the real `AgentLoop`, the real durable checkpoint store, the
 * real intent-keyed approval service, and the real `RunEventStore` on PostgreSQL — across a park
 * and a resume, and asserts on the rows the participant's stream is actually read from.
 */

const RUN_ID = "00000000-0000-4000-8000-0000000000b1";
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

/** The Turn's one and only attempt: a chat retry mints a new Run, so this never moves. */
const ATTEMPT = 1;

const WRITE_TOOL = "crm.customer.update";
const TOOLS = [{ name: WRITE_TOOL, inputSchema: { type: "object" }, mutating: true }];

/** Text the model streams before it parks, and after it resumes. Order is the assertion. */
const PARKED_DELTAS = ["Upgrading ", "cust-1"] as const;
const RESUMED_DELTAS = [" — cust-1 ", "is now gold."] as const;

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

/** Streams the given deltas, then settles with `result` — the shape a real adapter produces. */
class StreamingModel implements ModelPort {
  constructor(
    private readonly deltas: readonly string[],
    private readonly result: ModelInvocationResult
  ) {}

  async invoke(): Promise<ModelInvocationResult> {
    return this.result;
  }

  async *stream(_request: ModelInvocationRequest): AsyncIterable<ModelStreamChunk> {
    for (const text of this.deltas) yield { kind: "text_delta", text };
    yield { kind: "completed", result: this.result };
  }
}

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

/** Decides the approval strictly before the Tool runs, as the production dispatcher does. */
function dispatcher(approvals: ToolApprovalService): ToolDispatchPort {
  return {
    dispatch: async (request: ToolDispatchRequest): Promise<ToolDispatchResult> => {
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
      return { status: "succeeded", callId: request.callId, output: { updated: true } };
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

interface EventRow {
  sequence: string;
  event_type: string;
  idempotency_key: string;
  payload: { text?: string; index?: number };
}

describe("resumed Turn Run event keys (L4-7)", () => {
  let database: PGlite;
  let transactions: TransactionPort;
  let checkpoints: RunLoopCheckpointStore;
  let events: RunEventStore;
  let approvals: ToolApprovalService;
  let repo: ApprovalsRepo;

  beforeEach(async () => {
    database = await makeMigratedPglite();
    transactions = {
      withTransaction: (operation) =>
        database.transaction((transaction) =>
          operation(transaction as unknown as StorageQueryable)
        ),
    };
    await new RunStore(transactions).start(startRun());
    checkpoints = new RunLoopCheckpointStore(transactions);
    events = new RunEventStore(transactions);
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

  /**
   * One `AgentLoop.run` sinking into a fresh `TurnEventWriter` — the composition
   * `createChatExecutor` builds, including that the writer is rebuilt per pass and carries the
   * Turn's unchanged attempt.
   */
  async function runPass(model: ModelPort, tools: ToolDispatchPort) {
    const writer = new TurnEventWriter({
      events,
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId: RUN_ID,
      turnId: TURN_ID,
      attempt: ATTEMPT,
      now: () => CREATED_AT,
    });
    return new AgentLoop({
      model,
      tools,
      checkpoints,
      events: writer,
      budget: { consume: async () => ({ outcome: "ok" }) },
      isCancelled: async () => false,
    }).run(loopInput());
  }

  async function deltaRows(): Promise<readonly EventRow[]> {
    const result = await database.query<EventRow>(
      `SELECT sequence, event_type, idempotency_key, payload
         FROM run_events WHERE run_id = $1 AND event_type = 'text.delta' ORDER BY sequence`,
      [RUN_ID]
    );
    return result.rows;
  }

  it("numbers a resumed Turn's events past the ones its parked pass already wrote", async () => {
    const tools = dispatcher(approvals);

    // Pass 1: the model streams, then proposes the write that parks the Turn on an approval.
    const parked = await runPass(
      new StreamingModel([...PARKED_DELTAS], toolCall("c1", WRITE_TOOL, { tier: "gold" })),
      tools
    );
    expect(parked).toMatchObject({ status: "awaiting_approval", callId: "c1" });

    const approvalId = (parked as { approvalId: string }).approvalId;
    expect(await repo.settlePending(approvalId, "approved")).toBe(true);

    // Pass 2: the same Turn, the same attempt, re-entering the same State after the approval.
    const resumed = await runPass(
      new StreamingModel([...RESUMED_DELTAS], finalText("cust-1 is now gold.")),
      tools
    );
    expect(resumed).toMatchObject({ status: "completed" });

    const rows = await deltaRows();

    // Every delta the model streamed is durable. A key collision would not have raised: the store
    // resolves a duplicate key by keeping the older row, so a dropped delta shows up only here.
    expect(rows.map((row) => row.payload.text)).toEqual([...PARKED_DELTAS, ...RESUMED_DELTAS]);

    // The resumed pass counted on from the parked pass's sequence rather than restarting at 1.
    // Which numbers it lands on is the loop's business — that they only ever climb is not.
    const loopNumbers = rows.map((row) => {
      const match = /^(.+):loop:(\d+)$/.exec(row.idempotency_key);
      expect(match?.[1], `unexpected loop event key ${row.idempotency_key}`).toBe(
        `${TURN_ID}:${ATTEMPT}`
      );
      return Number(match?.[2]);
    });
    expect(loopNumbers).toEqual([...loopNumbers].sort((a, b) => a - b));
    expect(new Set(loopNumbers).size).toBe(loopNumbers.length);

    // Ordering a reader sees stays deterministic and monotonic across the park, on both the
    // cursor it resumes by and the text index it renders by.
    expect(rows.map((row) => Number(row.sequence))).toEqual([1, 2, 3, 4]);
    expect(rows.map((row) => row.payload.index)).toEqual([1, 2, 3, 4]);

    // No two events in the Run share a key — including the fixed-key ones the driver re-emits.
    const all = await database.query<{ total: string; distinct: string }>(
      `SELECT count(*) AS total, count(DISTINCT idempotency_key) AS distinct
         FROM run_events WHERE run_id = $1`,
      [RUN_ID]
    );
    expect(all.rows[0]?.total).toBe(all.rows[0]?.distinct);
  });

  it("shows why a collision is silent: the store keeps the first row and reports its sequence", async () => {
    // The consequence this test exists to prevent, stated as an executable fact rather than a
    // comment. `RunEventStore.append` is `ON CONFLICT DO NOTHING`; a colliding writer is told it
    // succeeded and handed a sequence *behind* the one it thought it wrote.
    const key = `${TURN_ID}:${ATTEMPT}:loop:1`;
    const append = (text: string) =>
      events.append({
        businessId: DEPLOYMENT_BUSINESS_ID,
        runId: RUN_ID,
        eventType: "text.delta",
        audience: "participant",
        payload: { text, index: 1 },
        idempotencyKey: key,
        occurredAt: CREATED_AT.toISOString(),
      });

    const first = await append("the parked pass wrote this");
    const colliding = await append("the resumed pass loses this");

    expect(colliding.sequence).toBe(first.sequence);
    expect(colliding.payload.text).toBe("the parked pass wrote this");
    const rows = await deltaRows();
    expect(rows).toHaveLength(1);
  });
});
