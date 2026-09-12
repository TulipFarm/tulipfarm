import {
  AgentLoop,
  type AgentLoopCheckpoint,
  InMemoryLoopCheckpointStore,
} from "@tulipfarm/agent-runtime";
import { textContent } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { resumableFromPreviousRun } from "./chat-executor";

// Retry mints a *new* Run, and checkpoints are keyed by Run, so the retry's own key holds nothing
// and the loop re-runs every Tool the failed attempt already paid for. Reading the predecessor's
// row through — never writing to it — is what makes a retry cheap without racing the executor.

const BUSINESS = "business-1";
const PREVIOUS_RUN = "run-1";
const RETRY_RUN = "run-2";
const STATE = "invoke";

function withWork(overrides: Partial<AgentLoopCheckpoint> = {}): AgentLoopCheckpoint {
  return {
    businessId: BUSINESS,
    runId: PREVIOUS_RUN,
    stateId: STATE,
    iterations: 5,
    toolCalls: 5,
    repairs: 0,
    resume: {
      messages: [{ role: "assistant", content: textContent("stargazers_count: 412") }],
      sequence: 9,
      textIndex: 0,
    },
    ...overrides,
  };
}

describe("resumableFromPreviousRun", () => {
  it("hands the retry the work the failed attempt already paid for", async () => {
    const inner = new InMemoryLoopCheckpointStore();
    await inner.save(withWork());

    const loaded = await resumableFromPreviousRun(inner, PREVIOUS_RUN).load(
      BUSINESS,
      RETRY_RUN,
      STATE
    );

    expect(loaded?.resume?.messages).toHaveLength(1);
    expect(loaded?.toolCalls).toBe(5);
    // Re-keyed to the Run doing the reading, so nothing downstream writes back to the dead Run.
    expect(loaded?.runId).toBe(RETRY_RUN);
  });

  it("ignores a predecessor that kept only counters", async () => {
    const inner = new InMemoryLoopCheckpointStore();
    const { resume: _dropped, ...countersOnly } = withWork();
    await inner.save(countersOnly);

    const loaded = await resumableFromPreviousRun(inner, PREVIOUS_RUN).load(
      BUSINESS,
      RETRY_RUN,
      STATE
    );

    // A settled loop drops its transcript on purpose. Adopting the spend without the results
    // would charge this attempt for Tool calls it never receives, and could exhaust the ceiling
    // before its first call.
    expect(loaded).toBeUndefined();
  });

  it("does not redeliver a previous Run's terminal event under a retry Run", async () => {
    const inner = new InMemoryLoopCheckpointStore();
    await inner.save(
      withWork({
        resume: {
          messages: [],
          sequence: 10,
          textIndex: 0,
          terminal: {
            outcome: {
              status: "completed",
              output: "old answer",
              iterations: 5,
              toolCalls: 5,
              repairs: 0,
            },
            event: {
              sequence: 10,
              businessId: BUSINESS,
              runId: PREVIOUS_RUN,
              stateId: STATE,
              type: "completed",
              iteration: 5,
              occurredAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
      })
    );

    expect(
      await resumableFromPreviousRun(inner, PREVIOUS_RUN).load(BUSINESS, RETRY_RUN, STATE)
    ).toBeUndefined();
  });

  it("gives a new retry Run prior Tool results even if terminal cleanup was not acknowledged", async () => {
    const inner = new InMemoryLoopCheckpointStore();
    await inner.save(
      withWork({
        resume: {
          messages: [{ role: "tool", content: textContent('{"callId":"c1","stars":412}') }],
          sequence: 10,
          textIndex: 0,
          terminal: {
            retryable: true,
            outcome: {
              status: "failed",
              reason: "model_provider_unavailable",
              iterations: 5,
              toolCalls: 5,
              repairs: 0,
            },
            event: {
              sequence: 10,
              businessId: BUSINESS,
              runId: PREVIOUS_RUN,
              stateId: STATE,
              type: "failed",
              iteration: 5,
              occurredAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
      })
    );
    let modelCalls = 0;
    let toolCalls = 0;
    const outcome = await new AgentLoop({
      model: {
        invoke: async (request) => {
          modelCalls += 1;
          expect(JSON.stringify(request.messages)).toContain("412");
          return {
            requestId: request.requestId,
            output: { kind: "text", text: "recovered" },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
      tools: {
        dispatch: async () => {
          toolCalls += 1;
          throw new Error("prior mutation must not run");
        },
      },
      checkpoints: resumableFromPreviousRun(inner, PREVIOUS_RUN),
      events: { append: async () => {} },
      budget: { consume: async () => ({ outcome: "allowed" }) },
      isCancelled: async () => false,
    }).run({
      businessId: BUSINESS,
      runId: RETRY_RUN,
      stateId: STATE,
      modelProfileId: "primary",
      contextDigest: "sha256:context",
      guardrailDigest: "sha256:guardrail",
      messages: [{ role: "user", content: textContent("retry") }],
      tools: [{ name: "write", inputSchema: { type: "object" }, mutating: true }],
      limits: { maxIterations: 8, maxToolCalls: 8, maxRepairAttempts: 2 },
    });

    expect(outcome).toMatchObject({ status: "completed", toolCalls: 5, iterations: 6 });
    expect(modelCalls).toBe(1);
    expect(toolCalls).toBe(0);
  });

  it("prefers the retry's own progress once it has any", async () => {
    const inner = new InMemoryLoopCheckpointStore();
    await inner.save(withWork());
    await inner.save(withWork({ runId: RETRY_RUN, toolCalls: 7 }));

    const loaded = await resumableFromPreviousRun(inner, PREVIOUS_RUN).load(
      BUSINESS,
      RETRY_RUN,
      STATE
    );

    expect(loaded?.toolCalls).toBe(7);
  });

  it("never writes to the predecessor", async () => {
    const inner = new InMemoryLoopCheckpointStore();
    await inner.save(withWork());

    await resumableFromPreviousRun(inner, PREVIOUS_RUN).save(
      withWork({ runId: RETRY_RUN, toolCalls: 6 })
    );

    expect((await inner.load(BUSINESS, PREVIOUS_RUN, STATE))?.toolCalls).toBe(5);
    expect((await inner.load(BUSINESS, RETRY_RUN, STATE))?.toolCalls).toBe(6);
  });
});
