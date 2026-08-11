import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { routineEffectId } from "../scheduling";
import { RoutineStepError } from "./step";
import { compileWithTargets } from "./test-support";
import { planToolDispatch, routineIdempotencyKey } from "./tool";

const CTX = {
  businessId: "biz-1",
  runId: "11111111-1111-4111-8111-111111111111",
  stateKey: "CommentIssue",
};

function toolState(overrides: Record<string, unknown> = {}): routineSchema.RoutineState {
  return {
    type: "tool",
    name: "CommentIssue",
    toolRef: { name: "github.issue.comment", version: "1.0.0" },
    action: "issue.comment",
    destination: "github",
    credentialRef: "secret://integrations/github/triage",
    input: { issueNumber: `\${input.issueNumber}`, body: "hello" },
    end: true,
    ...overrides,
  } as routineSchema.RoutineState;
}

describe("planToolDispatch", () => {
  it("plans the authored dispatch with its arguments resolved from the Context", () => {
    const plan = planToolDispatch(
      compileWithTargets(toolState()),
      { input: { issueNumber: 7 } },
      CTX
    );

    expect(plan.toolRef).toEqual({ name: "github.issue.comment", version: "1.0.0" });
    expect(plan.action).toBe("issue.comment");
    expect(plan.destination).toBe("github");
    expect(plan.credentialRef).toBe("secret://integrations/github/triage");
    expect(plan.arguments).toEqual({ issueNumber: 7, body: "hello" });
  });

  it("derives the idempotency key and effect id from the Run and the State occurrence", () => {
    const plan = planToolDispatch(
      compileWithTargets(toolState()),
      { input: { issueNumber: 7 } },
      CTX
    );

    expect(plan.idempotencyKey).toBe(routineIdempotencyKey(CTX.runId, CTX.stateKey));
    expect(plan.effectId).toBe(routineEffectId(CTX.runId, CTX.stateKey));
  });

  it("replays to the same identities and arguments, so a retry converges on one effect", () => {
    const state = compileWithTargets(toolState());
    const first = planToolDispatch(state, { input: { issueNumber: 7 } }, CTX);
    const second = planToolDispatch(state, { input: { issueNumber: 7 } }, CTX);

    expect(second).toEqual(first);
  });

  it("addresses a fan-out occurrence separately from the authored State", () => {
    const state = compileWithTargets(toolState());
    const unit = planToolDispatch(
      state,
      { input: { issueNumber: 7 } },
      {
        ...CTX,
        stateKey: "Fanout#item-2/CommentIssue",
      }
    );

    expect(unit.effectId).not.toBe(routineEffectId(CTX.runId, CTX.stateKey));
    expect(unit.idempotencyKey).toContain("Fanout#item-2/CommentIssue");
  });

  it("refuses a State whose authored Tool reference is unusable", () => {
    const state = compileWithTargets(toolState());
    const definition: routineSchema.RoutineState = {
      type: "agent",
      name: "CommentIssue",
      agentRef: { name: "triage", version: "1.0.0" },
      end: true,
    };
    const withoutRef = { ...state, definition };

    expect(() => planToolDispatch(withoutRef, {}, CTX)).toThrow(
      new RoutineStepError("missing_tool_ref", "CommentIssue")
    );
  });

  it("refuses to plan a State that is not a Tool State", () => {
    const agent = compileWithTargets({
      type: "agent",
      name: "Classify",
      agentRef: { name: "triage", version: "1.0.0" },
      end: true,
    } as routineSchema.RoutineState);

    expect(() => planToolDispatch(agent, {}, CTX)).toThrow(RoutineStepError);
  });
});
