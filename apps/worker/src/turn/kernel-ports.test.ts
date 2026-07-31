import type { PersistedState, RunStore, StateTransitionInput } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import type { StateTransitionPort } from "../agent-state";
import {
  MissingStateError,
  RunStoreStateTransitions,
  reclaimWaitingState,
  StateTransitionConflictError,
} from "./kernel-ports";

function state(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    businessId: "business-1",
    runId: "run-1",
    key: "invoke",
    definitionRef: "published:agent:assistant",
    resolvedInput: { payloadRef: "artifact:run-1:request" },
    status: "running",
    version: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    resultArtifactId: null,
    errorEvidenceRef: null,
    ...overrides,
  };
}

function runs(options: { found: PersistedState | null; moved: boolean }): {
  runs: Pick<RunStore, "findState" | "transitionState">;
  transitions: StateTransitionInput[];
} {
  const transitions: StateTransitionInput[] = [];
  return {
    runs: {
      findState: async () => options.found,
      transitionState: async (_businessId, _runId, _stateKey, transition) => {
        transitions.push(transition);
        return options.moved;
      },
    },
    transitions,
  };
}

const REQUEST = {
  businessId: "business-1",
  runId: "run-1",
  stateKey: "invoke",
} as const;

describe("RunStoreStateTransitions", () => {
  it("guards the write with the version it just read", async () => {
    const store = runs({ found: state(), moved: true });

    await new RunStoreStateTransitions(store.runs).transition({
      ...REQUEST,
      from: "running",
      to: "succeeded",
    });

    expect(store.transitions[0]).toMatchObject({
      expectedVersion: 4,
      expectedStatus: "running",
      status: "succeeded",
    });
  });

  it("raises when the State moved under it, rather than overwriting the winner", async () => {
    const store = runs({ found: state(), moved: false });

    await expect(
      new RunStoreStateTransitions(store.runs).transition({
        ...REQUEST,
        from: "running",
        to: "succeeded",
      })
    ).rejects.toBeInstanceOf(StateTransitionConflictError);
  });

  it("raises when the State does not exist at all", async () => {
    const store = runs({ found: null, moved: true });

    await expect(
      new RunStoreStateTransitions(store.runs).transition({
        ...REQUEST,
        from: "claimed",
        to: "running",
      })
    ).rejects.toBeInstanceOf(MissingStateError);
  });

  it("records a reason only where one can be retracted", async () => {
    // `RunStore` never clears `error_evidence_ref`, so writing one on a healthy State would leave
    // it permanently carrying an error nobody can take back.
    const failing = runs({ found: state(), moved: true });
    await new RunStoreStateTransitions(failing.runs).transition({
      ...REQUEST,
      from: "running",
      to: "needs_reconciliation",
      reason: "agent_loop_error",
    });
    expect(failing.transitions[0]?.errorEvidenceRef).toBe("agent_loop_error");

    const succeeding = runs({ found: state(), moved: true });
    await new RunStoreStateTransitions(succeeding.runs).transition({
      ...REQUEST,
      from: "running",
      to: "succeeded",
      reason: "ignored",
    });
    expect(succeeding.transitions[0]?.errorEvidenceRef).toBeUndefined();
  });

  it("stamps started and finished times from the status it is moving to", async () => {
    const started = runs({ found: state({ status: "claimed" }), moved: true });
    await new RunStoreStateTransitions(started.runs).transition({
      ...REQUEST,
      from: "claimed",
      to: "running",
    });
    expect(started.transitions[0]?.startedAt).toEqual(expect.any(String));
    expect(started.transitions[0]?.finishedAt).toBeUndefined();

    const finished = runs({ found: state(), moved: true });
    await new RunStoreStateTransitions(finished.runs).transition({
      ...REQUEST,
      from: "running",
      to: "failed",
    });
    expect(finished.transitions[0]?.finishedAt).toEqual(expect.any(String));
  });
});

describe("reclaimWaitingState", () => {
  function recorder(failAt?: string): {
    port: StateTransitionPort;
    hops: Array<{ from: string; to: string }>;
  } {
    const hops: Array<{ from: string; to: string }> = [];
    return {
      hops,
      port: {
        transition: async (input) => {
          if (input.to === failAt) {
            throw new StateTransitionConflictError(
              input.runId,
              input.stateKey,
              input.from,
              input.to
            );
          }
          hops.push({ from: input.from, to: input.to });
        },
      },
    };
  }

  it("offers the parked State and claims it again, since waiting -> running is not a transition", async () => {
    const { port, hops } = recorder();

    await reclaimWaitingState(port, REQUEST);

    expect(hops).toEqual([
      { from: "waiting", to: "ready" },
      { from: "ready", to: "claimed" },
    ]);
  });

  it("raises rather than stealing a State another worker claimed first", async () => {
    const { port, hops } = recorder("claimed");

    await expect(reclaimWaitingState(port, REQUEST)).rejects.toBeInstanceOf(
      StateTransitionConflictError
    );
    expect(hops).toEqual([{ from: "waiting", to: "ready" }]);
  });
});
