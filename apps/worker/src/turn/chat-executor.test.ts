import {
  DEFAULT_GUARDRAILS,
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

const STATE: PersistedState = {
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

const CONTEXT: ResolvedTurnContext = {
  agentId: "agent-1",
  subjectId: "user-1",
  modelProfileId: "primary",
  contextDigest: "sha256:context",
  guardrailDigest: canonicalHash(DEFAULT_GUARDRAILS),
  guardrailPolicy: DEFAULT_GUARDRAILS as unknown as Record<string, unknown>,
  messages: [{ role: "user", content: "how many tasks are open?" }],
  tools: [],
  limits: { maxIterations: 4, maxToolCalls: 4, maxRepairAttempts: 2 },
  compacted: false,
};

interface Recorded {
  readonly events: { eventType: string; payload: Record<string, unknown> }[];
  readonly messages: string[];
  readonly completions: { status: string; messageId: string | null }[];
  readonly transitions: { from: string; to: string }[];
  readonly charges: { key: string; amount: number }[];
  readonly contexts: number;
}

function harness(
  over: {
    turn?: { turnId: string; conversationId: string; attempt: number } | undefined;
    state?: PersistedState | null;
    answer?: string;
    run?: PersistedRun;
  } = {}
): { execute: () => Promise<string>; recorded: Recorded } {
  const events: Recorded["events"] = [];
  const messages: string[] = [];
  const completions: Recorded["completions"] = [];
  const transitions: Recorded["transitions"] = [];
  const charges: Recorded["charges"] = [];
  let contexts = 0;
  let sequence = 0;

  const host: ChatExecutorHost & TurnCompletionStore & ToolDispatchPort = {
    findTurn: async () =>
      "turn" in over ? over.turn : { turnId: "turn-1", conversationId: "conv-1", attempt: 1 },
    findCompletion: async (): Promise<TurnCompletionRecord | undefined> => undefined,
    appendAssistantMessage: async (input) => {
      messages.push(input.content);
      return { messageId: `message-${messages.length}` };
    },
    completeTurn: async (input) => {
      completions.push({ status: input.status, messageId: input.messageId });
    },
    // No Tool is exposed in this Context, so a dispatch here would be the loop inventing a call.
    dispatch: async (): Promise<ToolDispatchResult> => {
      throw new Error("no Tool dispatch expected");
    },
  };

  const appendPort: RunEventAppendPort = {
    append: async (input) => {
      sequence += 1;
      events.push({ eventType: input.eventType, payload: input.payload });
      return { sequence };
    },
  };

  const context: TurnContextPort = {
    resolve: async () => {
      contexts += 1;
      return CONTEXT;
    },
  };

  const model: ModelPort = {
    invoke: async (request: ModelInvocationRequest): Promise<ModelInvocationResult> => ({
      requestId: request.requestId,
      output: { kind: "text", text: over.answer ?? "three" },
      usage: { inputTokens: 12, outputTokens: 3 },
    }),
  };

  const executor = createChatExecutor({
    host,
    context,
    runs: {
      find: async () => over.run ?? RUN,
      findState: async () => ("state" in over ? (over.state ?? null) : STATE),
    },
    events: appendPort,
    budgets: {
      open: async () => {},
      consume: async (_businessId, _runId, key, amount): Promise<BudgetConsumeResult> => {
        charges.push({ key, amount });
        return { outcome: "unbounded", consumed: amount, limit: null, exhaustionPolicy: null };
      },
    },
    transitions: {
      transition: async (input) => {
        transitions.push({ from: input.from, to: input.to });
      },
    },
    waits: { register: async () => ({ waitId: "wait-1" }) },
    model,
    log: { warn: () => {} },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  return {
    execute: () => executor(over.run ?? RUN),
    recorded: {
      events,
      messages,
      completions,
      transitions,
      charges,
      get contexts() {
        return contexts;
      },
    },
  };
}

describe("createChatExecutor", () => {
  it("runs the turn and leaves the Run succeeded with the answer persisted", async () => {
    const { execute, recorded } = harness();

    await expect(execute()).resolves.toBe("succeeded");

    expect(recorded.messages).toEqual(["three"]);
    expect(recorded.completions).toEqual([{ status: "succeeded", messageId: "message-1" }]);
    expect(recorded.transitions).toEqual([
      { from: "claimed", to: "running" },
      { from: "running", to: "succeeded" },
    ]);
  });

  it("emits the turn's events in the order a reader depends on", async () => {
    // `turn.finished` last, and only after the Message it names is durable.
    const { execute, recorded } = harness();

    await execute();

    expect(recorded.events.map((event) => event.eventType)).toEqual([
      "turn.started",
      "context.assembled",
      "turn.finished",
    ]);
    expect(recorded.events.at(-1)?.payload).toEqual({
      status: "succeeded",
      messageId: "message-1",
    });
  });

  it("charges the Run's durable budget, not a counter that dies with this process", async () => {
    // A resumed State has to stay capped by what earlier attempts already spent.
    const { execute, recorded } = harness();

    await execute();

    expect(recorded.charges).toContainEqual({ key: "iterations", amount: 1 });
    expect(recorded.charges).toContainEqual({ key: "tokens", amount: 15 });
  });

  it("succeeds without running a turn when the Run names no Turn", async () => {
    // Superseded by a retry, or already answered. Failing it would tell a reader the conversation
    // broke when it did not.
    const { execute, recorded } = harness({ turn: undefined });

    await expect(execute()).resolves.toBe("succeeded");

    expect(recorded.contexts).toBe(0);
    expect(recorded.messages).toEqual([]);
    expect(recorded.events).toEqual([]);
  });

  it("asks for reconciliation when the invoke State is missing, rather than inventing one", async () => {
    // A Chat Run without it cannot have been minted by the invocation gateway; guessing a status
    // here would let the executor drive a State nobody claimed.
    const { execute, recorded } = harness({ state: null });

    await expect(execute()).resolves.toBe("needs_reconciliation");

    expect(recorded.contexts).toBe(0);
    expect(recorded.transitions).toEqual([]);
  });

  it("re-claims the State a resumed Run is still parked on, rather than restarting anything", async () => {
    // An approved Run comes back with its `invoke` State `waiting`, and the kernel has no
    // `waiting -> running` edge. Offering and claiming it again is what makes the approval a pause:
    // same Run, same State, same Turn — no second Message.
    const { execute, recorded } = harness({ state: { ...STATE, status: "waiting" } });

    await expect(execute()).resolves.toBe("succeeded");

    expect(recorded.transitions).toEqual([
      { from: "waiting", to: "ready" },
      { from: "ready", to: "claimed" },
      { from: "claimed", to: "running" },
      { from: "running", to: "succeeded" },
    ]);
    expect(recorded.completions).toEqual([{ status: "succeeded", messageId: "message-1" }]);
  });

  it("claims a fresh Run's State from `pending`, the gateway's insert default", async () => {
    // The invocation gateway persists a new invoke State at `pending` — the same INSERT a
    // Routine's start State gets — and nothing leases a State the way a Run is leased. Left
    // unclaimed, `pending -> running` is not a legal kernel transition and the executor would
    // throw before ever resolving Context.
    const { execute, recorded } = harness({ state: { ...STATE, status: "pending" } });

    await expect(execute()).resolves.toBe("succeeded");

    expect(recorded.transitions).toEqual([
      { from: "pending", to: "ready" },
      { from: "ready", to: "claimed" },
      { from: "claimed", to: "running" },
      { from: "running", to: "succeeded" },
    ]);
    expect(recorded.completions).toEqual([{ status: "succeeded", messageId: "message-1" }]);
  });

  it("stops the loop when the Run is being cancelled elsewhere", async () => {
    // Cancellation is requested by whoever owns the Run — an operator, a parent Run — and none of
    // them can reach into this process, so it is read from the Run on each iteration.
    const { execute, recorded } = harness({ run: { ...RUN, status: "cancelling" } });

    await expect(execute()).resolves.toBe("cancelled");

    expect(recorded.messages).toEqual([]);
    expect(recorded.completions).toEqual([]);
  });
});
