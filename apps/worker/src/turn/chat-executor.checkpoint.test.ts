import {
  DEFAULT_GUARDRAILS,
  InMemoryLoopCheckpointStore,
  type LoopCheckpointStore,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelPort,
  type ToolDispatchPort,
  type ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import { canonicalHash } from "@tulipfarm/schema";
import type { BudgetConsumeResult, PersistedRun, PersistedState } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import type { TurnCompletionRecord, TurnCompletionStore } from "../conversation-turn";
import { type ChatExecutorHost, createChatExecutor } from "./chat-executor";
import type { ResolvedTurnContext, TurnContextPort } from "./driver";
import type { RunEventAppendPort } from "./run-events";

// This proves the wiring, not the loop: an approval park re-enters the same Run through a *second*
// executor call, and the advertised one-Tool ceiling must still hold. It holds only because the
// executor threads the injected durable-style store into both invocations. Revert the executor's
// `options.checkpoints ?? …` back to an inline `new InMemoryLoopCheckpointStore()` and the second
// call reloads nothing, restarts `toolCalls` at zero, and dispatches a Tool past the limit.

const RUN: PersistedRun = {
  id: "run-1",
  businessId: "business-1",
  source: "chat",
  bundle: { digest: "sha256:bundle", routineId: "chat", routineVersion: "1" },
  identity: {
    initiator: { kind: "user", id: "user-1" },
    effectiveSubject: { kind: "user", id: "user-1" },
    guardrailContextRef: "sha256:guardrail",
  },
  bounds: { wallTimeMs: 60_000, activeTimeMs: 30_000, attempts: 3, sideEffects: 10 },
  status: "running",
  version: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: null,
  resultArtifactId: null,
  errorEvidenceRef: null,
  leaseOwner: "worker-1",
  leaseExpiresAt: "2026-01-01T00:01:00.000Z",
};

const CLAIMED_STATE: PersistedState = {
  businessId: "business-1",
  runId: "run-1",
  key: "invoke",
  definitionRef: "published:agent:assistant",
  resolvedInput: { payloadRef: "artifact:run-1:request" },
  status: "claimed",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  resultArtifactId: null,
  errorEvidenceRef: null,
};

const WAITING_STATE: PersistedState = { ...CLAIMED_STATE, status: "waiting" };

// One mutating Tool, one Tool-call allowed. The park spends that one; the resume must not get it back.
const CONTEXT: ResolvedTurnContext = {
  agentId: "agent-1",
  subjectId: "user-1",
  modelProfileId: "primary",
  contextDigest: "sha256:context",
  guardrailDigest: canonicalHash(DEFAULT_GUARDRAILS),
  guardrailPolicy: DEFAULT_GUARDRAILS as unknown as Record<string, unknown>,
  messages: [{ role: "user", content: "comment on the issue" }],
  tools: [
    {
      name: "github.issue.comment",
      inputSchema: { type: "object" },
      mutating: true,
      tier: "standard",
    },
  ],
  limits: { maxIterations: 6, maxToolCalls: 1, maxRepairAttempts: 2 },
  compacted: false,
};

function toolCall(callId: string): ModelInvocationResult {
  return {
    requestId: "req",
    output: {
      kind: "tool_calls",
      calls: [{ callId, name: "github.issue.comment", arguments: { body: "hi" } }],
    },
    usage: { inputTokens: 5, outputTokens: 5 },
  };
}

function text(answer: string): ModelInvocationResult {
  return {
    requestId: "req",
    output: { kind: "text", text: answer },
    usage: { inputTokens: 5, outputTokens: 5 },
  };
}

/**
 * One executor over both invocations. The model plays a Tool call to park (call 1), a Tool call on
 * resume (call 2), then a plain answer (call 3) — so a store that forgot the park would happily
 * dispatch call 2 and finish, while a store that remembered it refuses call 2 at the ceiling.
 */
function harness(checkpoints: LoopCheckpointStore) {
  const dispatched: string[] = [];
  let modelCall = 0;
  let state: PersistedState = CLAIMED_STATE;

  const host: ChatExecutorHost & TurnCompletionStore & ToolDispatchPort = {
    findTurn: async () => ({ turnId: "turn-1", conversationId: "conv-1", attempt: 1 }),
    findCompletion: async (): Promise<TurnCompletionRecord | undefined> => undefined,
    appendAssistantMessage: async () => ({ messageId: "message-1" }),
    completeTurn: async () => {},
    dispatch: async (input): Promise<ToolDispatchResult> => {
      dispatched.push(input.callId);
      // The first call parks for a human; a later one would land, if it were ever reached.
      if (dispatched.length === 1) {
        return { status: "awaiting_approval", callId: input.callId, approvalId: "approval-1" };
      }
      return { status: "succeeded", callId: input.callId, output: { ok: true } };
    },
  };

  const model: ModelPort = {
    invoke: async (request: ModelInvocationRequest): Promise<ModelInvocationResult> => {
      modelCall += 1;
      if (modelCall === 1) return { ...toolCall("call-1"), requestId: request.requestId };
      if (modelCall === 2) return { ...toolCall("call-2"), requestId: request.requestId };
      return { ...text("done"), requestId: request.requestId };
    },
  };

  const executor = createChatExecutor({
    host,
    context: { resolve: async () => CONTEXT } satisfies TurnContextPort,
    runs: {
      find: async () => RUN,
      findState: async () => state,
    },
    events: { append: async () => ({ sequence: 1 }) } satisfies RunEventAppendPort,
    budgets: {
      open: async () => {},
      consume: async (): Promise<BudgetConsumeResult> => ({
        outcome: "unbounded",
        consumed: 0,
        limit: null,
        exhaustionPolicy: null,
      }),
    },
    transitions: { transition: async () => {} },
    waits: { register: async () => ({ waitId: "wait-1" }) },
    checkpoints,
    model,
    log: { warn: () => {} },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  return {
    dispatched,
    park: async () => {
      state = CLAIMED_STATE;
      return executor(RUN);
    },
    resume: async () => {
      state = WAITING_STATE;
      return executor(RUN);
    },
  };
}

describe("createChatExecutor durable loop counters", () => {
  it("keeps the maxToolCalls ceiling across an approval park", async () => {
    const checkpoints = new InMemoryLoopCheckpointStore();
    const scenario = harness(checkpoints);

    // First dispatch spends the single allowed Tool call and parks awaiting approval.
    await expect(scenario.park()).resolves.toBe("waiting");
    expect(scenario.dispatched).toEqual(["call-1"]);

    // Reclaimed after approval: the parked dispatch never executed, so its charge was refunded and
    // the approved call is replayed once — which spends the ceiling for real. The next Tool call is
    // then refused before it reaches the broker, and the loop fails on the limit.
    await expect(scenario.resume()).resolves.toBe("failed");
    expect(scenario.dispatched).toEqual(["call-1", "call-1"]);
  });
});
