import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { createRoutineAuthoringSession } from "./authoring";

const first: routineSchema.RoutineState = {
  name: "Collect",
  type: "agent",
  agentRef: { name: "expense-reader", version: "1.0.0" },
  transition: "Finish",
};
const finish: routineSchema.RoutineState = {
  name: "Finish",
  type: "approval",
  approverRoles: ["finance"],
  end: true,
};

const routine: routineSchema.RoutineDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "expense-report",
    displayName: "Expense report",
    schemaVersion: 1,
    authoredVersion: 3,
    lifecycle: "published",
  },
  spec: {
    owner: "finance",
    start: "Collect",
    states: [first, finish],
  },
};

describe("Routine authoring session", () => {
  it("keeps simple builder, graph, and YAML edits on one validated draft", () => {
    const session = createRoutineAuthoringSession(routine, "base-hash");

    session.updateSimple({ displayName: "Expense approval", owner: "finance-ops" });
    session.replaceGraphStates([
      { ...first, transition: "Review" },
      {
        name: "Review",
        type: "human_task",
        assigneeRoles: ["finance"],
        transition: "Finish",
      },
      finish,
    ]);
    const yaml = session.yaml();
    const yamlResult = session.updateYaml(yaml.replace("finance-ops", "finance-review"));

    expect(yamlResult.issues).toEqual([]);
    expect(session.snapshot()).toMatchObject({
      metadata: { displayName: "Expense approval" },
      spec: {
        owner: "finance-review",
        states: [
          { name: "Collect", transition: "Review" },
          { name: "Review", transition: "Finish" },
          { name: "Finish", end: true },
        ],
      },
    });
    expect(createRoutineAuthoringSession(session.snapshot(), "next").snapshot()).toEqual(
      session.snapshot()
    );
  });

  it("reports YAML/schema/semantic issues without replacing the last valid draft", () => {
    const session = createRoutineAuthoringSession(routine, "base-hash");
    const before = session.snapshot();

    expect(session.updateYaml("apiVersion: tulipfarm.ai/v1\nspec: [").issues[0]).toMatchObject({
      source: "yaml",
    });
    expect(session.snapshot()).toEqual(before);

    const invalid = session.yaml().replace("transition: Finish", "transition: Missing");
    expect(session.updateYaml(invalid).issues[0]).toMatchObject({ source: "semantic" });
    expect(session.snapshot()).toEqual(before);
  });

  it("builds a reviewable changeset proposal without publishing the base version", () => {
    const session = createRoutineAuthoringSession(routine, "published-hash");
    session.updateSimple({ displayName: "Expense approval" });

    const proposal = session.proposal({
      resultHash: "simulation-hash",
      steps: 3,
      effects: 0,
    });

    expect(proposal).toMatchObject({
      baseHash: "published-hash",
      publicationState: "draft",
      validationState: "valid",
      risk: "medium",
      approval: "required",
      simulation: { resultHash: "simulation-hash" },
    });
    expect(proposal.diff).toContain("-  displayName: Expense report");
    expect(proposal.diff).toContain("+  displayName: Expense approval");
    expect(routine.metadata.displayName).toBe("Expense report");
    expect(routine.metadata.lifecycle).toBe("published");
  });
});
