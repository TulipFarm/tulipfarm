import { type AgentLoopCheckpoint, InMemoryLoopCheckpointStore } from "@tulipfarm/agent-runtime";
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
