import {
  DEFAULT_GUARDRAILS,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelPort,
  type ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import { INVOKE_STATE_KEY } from "@tulipfarm/run-kernel";
import { canonicalHash, SUBAGENT_ANSWER_SCHEMA_REF, textContent } from "@tulipfarm/schema";
import type { BudgetConsumeResult, PersistedRun, PersistedState } from "@tulipfarm/storage";
import type { ResolvedTurnContext } from "@tulipfarm/turn-executor";
import { describe, expect, it } from "vitest";
import { subagentAnswerArtifactId } from "./completion";
import { createSubagentExecutor } from "./executor";

const BUSINESS_ID = "business-1";
const RUN_ID = "run-child";

const RUN: PersistedRun = {
  id: RUN_ID,
  businessId: BUSINESS_ID,
  source: "subagent",
  bundle: { digest: "sha256:bundle", routineId: "subagent", routineVersion: "1" },
  identity: {
    initiator: { kind: "user", id: "user-1" },
    effectiveSubject: { kind: "user", id: "user-1" },
    guardrailContextRef: "sha256:guardrail",
  },
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
  businessId: BUSINESS_ID,
  runId: RUN_ID,
  key: INVOKE_STATE_KEY,
  definitionRef: "adhoc:subagent",
  resolvedInput: { payloadRef: `artifact:${RUN_ID}:request` },
  status: "claimed",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  resultArtifactId: null,
  errorEvidenceRef: null,
  output: null,
};

const CONTEXT: ResolvedTurnContext = {
  agentId: "Summarizer",
  subjectId: "user-1",
  modelProfileId: "auto",
  contextDigest: "sha256:context",
  guardrailDigest: canonicalHash(DEFAULT_GUARDRAILS),
  guardrailPolicy: DEFAULT_GUARDRAILS as unknown as Record<string, unknown>,
  messages: [{ role: "user", content: textContent("summarize the incident") }],
  tools: [],
  limits: { maxIterations: 4, maxToolCalls: 4, maxRepairAttempts: 2 },
  compacted: false,
};

function harness(
  over: { answer?: string; state?: PersistedState | null; answered?: boolean } = {}
) {
  const published: Record<string, unknown>[] = [];
  const events: { eventType: string; payload: Record<string, unknown> }[] = [];
  const transitions: { from: string; to: string }[] = [];
  const present = new Set<string>(over.answered === true ? [subagentAnswerArtifactId(RUN_ID)] : []);
  let sequence = 0;

  const artifacts = {
    async read(input: { artifactId: string }) {
      if (!present.has(input.artifactId)) throw new Error("artifact_not_found");
      return { content: { answer: "already answered", steps: [] } };
    },
    async publish(input: Record<string, unknown>) {
      published.push(input);
      present.add(input.id as string);
      return { outcome: "created", id: input.id, contentHash: "h", blob: null };
    },
    // biome-ignore lint/suspicious/noExplicitAny: narrow fake standing in for the real service
  } as any;

  const model: ModelPort = {
    invoke: async (request: ModelInvocationRequest): Promise<ModelInvocationResult> => ({
      requestId: request.requestId,
      output: { kind: "text", text: over.answer ?? "the incident is closed" },
      usage: { inputTokens: 12, outputTokens: 3 },
    }),
  };

  const executor = createSubagentExecutor({
    artifacts,
    chat: {
      context: { resolve: async () => CONTEXT },
      tools: {
        dispatch: async (): Promise<ToolDispatchResult> => {
          throw new Error("no Tool dispatch expected");
        },
      },
      runs: {
        find: async () => RUN,
        findState: async () => ("state" in over ? (over.state ?? null) : STATE),
      },
      events: {
        append: async (input) => {
          sequence += 1;
          events.push({ eventType: input.eventType, payload: input.payload });
          return { sequence };
        },
      },
      budgets: {
        open: async () => {},
        consume: async (_b, _r, _key, amount): Promise<BudgetConsumeResult> => ({
          outcome: "unbounded",
          consumed: amount,
          limit: null,
          exhaustionPolicy: null,
        }),
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
    },
  });

  return { execute: () => executor(RUN), published, events, transitions };
}

describe("createSubagentExecutor", () => {
  it("answers into an Artifact rather than a Conversation Message", async () => {
    const { execute, published } = harness();

    await expect(execute()).resolves.toBe("succeeded");

    expect(published).toHaveLength(1);
    expect(published[0]?.id).toBe(subagentAnswerArtifactId(RUN_ID));
    expect(published[0]?.schemaRef).toBe(SUBAGENT_ANSWER_SCHEMA_REF);
    expect(published[0]?.value).toEqual({ answer: "the incident is closed", steps: [] });
  });

  it("drives the same State machine a chat Turn does", async () => {
    const { execute, transitions } = harness();

    await execute();

    expect(transitions).toEqual([
      { from: "claimed", to: "running" },
      { from: "running", to: "succeeded" },
    ]);
  });

  it("emits the Run events a trace is built from", async () => {
    const { execute, events } = harness();

    await execute();

    const types = events.map((event) => event.eventType);
    expect(types).toContain("turn.started");
    expect(types).toContain("context.assembled");
    expect(types).toContain("turn.finished");
  });

  it("keys its events off the Run's invoke State, since it has no Turn", async () => {
    const { execute, events } = harness();

    await execute();

    const started = events.find((event) => event.eventType === "turn.started");
    expect(started?.payload.turnId).toBe(INVOKE_STATE_KEY);
    expect(started?.payload.conversationId).toBe(RUN_ID);
  });

  it("does not answer twice when a redelivered attempt finds an answer already published", async () => {
    const { execute, published } = harness({ answered: true });

    await expect(execute()).resolves.toBe("succeeded");

    expect(published).toEqual([]);
  });

  it("fails closed when the Run carries no invoke State to run on", async () => {
    const { execute, published } = harness({ state: null });

    await expect(execute()).resolves.toBe("needs_reconciliation");
    expect(published).toEqual([]);
  });
});
