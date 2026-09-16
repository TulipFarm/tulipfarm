import { MANUAL_REQUEST_SCHEMA_REF, routine, YAML_PLAN_MAX_BYTES } from "@tulipfarm/schema";
import type { EnsureStateInput, PersistedState } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { SimulatedRunStore } from "../resilience/simulator";
import { compileRoutine } from "./compiler";
import { compileYamlPlan, YAML_PLAN_CHILD_DEADLINE_MS, YamlPlanError } from "./dag-plan";
import { createRoutineExecutor } from "./executor";
import { resolveRoutineStateInput } from "./input";
import { RoutineStateScheduler } from "./scheduling";

const header = "apiVersion: tulipfarm.ai/v1\nkind: Plan\nname: report\nversion: 2\n";
const source = `${header}steps:
  - id: Publish
    needs: [Draft, Archive]
    routine: {name: publish, version: "4.0.0"}
    input:
      text: \${states.Draft.output.text}
      record: \${states.Fetch.output.record}
  - id: Fetch
    tool: record_search
    label: Find records
    input:
      filter: \${input.filter}
  - id: Draft
    needs: [Fetch]
    agent: {name: writer, version: "2.0.0"}
    prompt: "Summarize \${states.Fetch.output.record}"
    requiredToolCalls: [record_search]
    output: {type: object}
  - id: Archive
    needs: [Fetch]
    tool: record_create
    input:
      fields: {record: "\${states.Fetch.output.record}"}
`;

function expectError(yaml: string, code?: string, path?: string): void {
  expect(() => compileYamlPlan(yaml)).toThrow(YamlPlanError);
  try {
    compileYamlPlan(yaml);
  } catch (error) {
    expect(error).toMatchObject({
      ...(code === undefined ? {} : { code }),
      ...(path === undefined ? {} : { path }),
    });
  }
}

describe("YAML Plan durable execution", () => {
  async function fixture(failure?: "action" | "child") {
    const definition = compileYamlPlan(`${header}steps:
    - {id: Fetch, tool: record_search, input: {query: "\${input.query}"}}
    - {id: Store, needs: [Fetch], tool: record_create, input: {record: "\${states.Fetch.output.record}"}}
    - {id: Publish, needs: [Store], routine: {name: publish, version: "4"}}
    - {id: Notify, needs: [Publish], tool: notify}
    `).definition;
    const run = new SimulatedRunStore().seedRun({
      status: "running",
      leaseOwner: "worker-1",
      leaseGeneration: 1,
    });
    const rows = new Map<string, PersistedState>();
    const scheduler = new RoutineStateScheduler({
      async ensureState(input: EnsureStateInput) {
        const existing = rows.get(input.key);
        if (existing) return { outcome: "existing", state: existing };
        const state: PersistedState = {
          businessId: input.businessId,
          runId: input.runId,
          key: input.key,
          definitionRef: input.definitionRef,
          resolvedInput: input.resolvedInput,
          status: "pending",
          version: 0,
          createdAt: input.createdAt,
          startedAt: null,
          finishedAt: null,
          resultArtifactId: null,
          errorEvidenceRef: null,
          output: null,
        };
        rows.set(input.key, state);
        return { outcome: "inserted", state };
      },
    });
    await scheduler.schedule({
      run,
      stateKey: "Fetch",
      definitionStateKey: "Fetch",
      resolvedInput: { payloadRef: "artifact:request" },
      createdAt: run.createdAt,
    });
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const execute = createRoutineExecutor({
      definitions: { load: async () => ({ document: definition, bundle: {} }) },
      artifacts: {
        read: async () => ({
          schemaRef: MANUAL_REQUEST_SCHEMA_REF,
          contentHash: "request-hash",
          content: { slug: "report", inputs: { query: "active" } },
        }),
      },
      runs: { listStates: async () => [...rows.values()] },
      scheduler,
      transitions: {
        async transition(input) {
          const row = rows.get(input.stateKey);
          if (!row) throw new Error("Missing State");
          expect(row.status).toBe(input.from);
          rows.set(row.key, {
            ...row,
            status: input.to,
            output: input.output?.value ?? row.output,
            errorEvidenceRef: input.reason ?? null,
          });
        },
      },
      waits: {
        register: async () => {
          throw new Error("Unexpected timer wait");
        },
        find: async () => null,
      },
      actions: {
        async execute({ plan }) {
          calls.push({ tool: plan.action, input: plan.arguments });
          return failure === "action"
            ? { kind: "failed", reason: "denied" }
            : { kind: "succeeded", output: { record: { id: "record-7" } } };
        },
      },
      childRoutines: {
        async start(input) {
          expect(input.mode).toBe("wait");
          expect(input.deadlineMs).toBe(YAML_PLAN_CHILD_DEADLINE_MS);
          expect(input.routineRef).toEqual({ name: "publish", version: "4" });
          calls.push({ tool: "routine", input: input.input });
          return { status: failure === "child" ? "failed" : "succeeded" };
        },
        find: async () => undefined,
      },
    });
    return { execute: () => execute(run), calls, rows };
  }

  it("orders calls, propagates real outputs, and replays without repeating settled effects", async () => {
    const run = await fixture();
    const result = await run.execute();
    expect(result, JSON.stringify([...run.rows.values()])).toEqual({ status: "succeeded" });
    expect(run.calls).toEqual([
      { tool: "record_search", input: { query: "active" } },
      { tool: "record_create", input: { record: { id: "record-7" } } },
      { tool: "routine", input: {} },
      { tool: "notify", input: {} },
    ]);
    await expect(run.execute()).resolves.toEqual({ status: "succeeded" });
    expect(run.calls).toHaveLength(4);
  });

  it.each(["action", "child"] as const)(
    "blocks dependencies when a %s fails, including replay",
    async (failure) => {
      const run = await fixture(failure);
      await expect(run.execute()).resolves.toMatchObject({ status: "failed" });
      const expectedCount = failure === "action" ? 1 : 3;
      expect(run.calls).toHaveLength(expectedCount);
      expect(run.rows.has("Notify")).toBe(false);
      await expect(run.execute()).resolves.toMatchObject({ status: "failed" });
      expect(run.calls).toHaveLength(expectedCount);
    }
  );
});

describe("compileYamlPlan", () => {
  it("lowers a hybrid diamond to a stable serial Routine and projects ready rounds", () => {
    const result = compileYamlPlan(source);
    expect(result.definition.spec.states).toEqual([
      {
        name: "Fetch",
        type: "action",
        action: "record_search",
        input: { filter: `\${input.filter}` },
        transition: "Draft",
      },
      {
        name: "Draft",
        type: "agent",
        agentRef: { name: "writer", version: "2.0.0" },
        input: { prompt: `Summarize \${states.Fetch.output.record}` },
        requiredToolCalls: ["record_search"],
        output: { type: "object" },
        transition: "Archive",
      },
      {
        name: "Archive",
        type: "action",
        action: "record_create",
        input: { fields: { record: `\${states.Fetch.output.record}` } },
        transition: "Publish",
      },
      {
        name: "Publish",
        type: "child_routine",
        routineRef: { name: "publish", version: "4.0.0" },
        mode: "wait",
        deadlineMs: YAML_PLAN_CHILD_DEADLINE_MS,
        input: { text: `\${states.Draft.output.text}`, record: `\${states.Fetch.output.record}` },
        end: true,
      },
    ]);
    expect(result.rounds).toEqual([
      { calls: [{ tool: "record_search", label: "Find records" }] },
      {
        calls: [
          { tool: "agent", label: "Draft" },
          { tool: "record_create", label: "Archive" },
        ],
      },
      { calls: [{ tool: "routine", label: "Publish" }] },
    ]);
    expect(result.steps[0]).toEqual({
      id: "Publish",
      needs: ["Draft", "Archive"],
      label: "Publish",
    });
    expect(result.definition.spec).not.toHaveProperty("triggers");
    expect(result.definition.metadata).toMatchObject({
      slug: "report",
      authoredVersion: 2,
      schemaVersion: 1,
      lifecycle: "published",
    });
    expect(routine.validateRoutineDefinition(result.definition).document).toEqual(
      result.definition
    );
    expect(compileYamlPlan(source)).toEqual(result);
  });

  it("preserves typed expressions and nested arguments through the Routine input resolver", () => {
    const compiled = compileRoutine(compileYamlPlan(source).definition, {
      identityCeiling: {
        principalKind: "user",
        principalId: "caller",
        grants: [],
        maxRiskClass: "low",
      },
    });
    const fetch = compiled.states.get("Fetch");
    const archive = compiled.states.get("Archive");
    if (!fetch || !archive) throw new Error("Missing compiled States");
    expect(
      resolveRoutineStateInput(fetch, { input: { filter: { active: true } }, states: {} })
    ).toEqual({
      filter: { active: true },
    });
    expect(
      resolveRoutineStateInput(archive, {
        input: {},
        states: { Fetch: { output: { record: { id: 7 } } } },
      })
    ).toEqual({ fields: { record: { id: 7 } } });
  });

  it.each([
    ["- id: A\n  tool: read\n- id: A\n  tool: write", "duplicate_step_id", "/steps/1/id"],
    ["- id: A\n  tool: read\n  needs: [Missing]", "unknown_dependency", "/steps/0/needs/0"],
    ["- id: A\n  tool: read\n  needs: [A]", "self_dependency", "/steps/0/needs/0"],
    [
      "- id: A\n  tool: read\n  needs: [B]\n- id: B\n  tool: write\n  needs: [A]",
      "dependency_cycle",
      "/steps",
    ],
    [
      "- id: A\n  tool: read\n  needs: [B, B]\n- id: B\n  tool: write",
      "SCHEMA_VALIDATION_FAILED",
      undefined,
    ],
  ])("rejects dependency defects: %s", (steps, code, path) => {
    expectError(`${header}steps:\n${steps}`, code, path);
  });

  it.each([
    `\${states.A.output.value}`,
    `\${states.B.output.value}`,
    `\${states.Unknown.output.value}`,
    `\${states}`,
    `\${states[input.target].output}`,
    `\${states["A"].output}`,
    `\${states.A}`,
    `\${states.A.input.value}`,
  ])("rejects undeclared or unprovable State reads: %s", (expression) => {
    expectError(
      `${header}steps:
- {id: A, tool: read}
- {id: B, tool: write, input: {value: '${expression}'}}`,
      "undeclared_state_reference",
      "/steps/1/input/value"
    );
  });

  it.each([
    `\${states.Child.output}`,
    `\${states.Child.output.foo}`,
    `\${states.Child.output.status}`,
    `\${states.Child.output[input.key]}`,
  ])("rejects unavailable child Routine output reads: %s", (expression) => {
    expectError(
      `${header}steps:
- {id: Child, routine: {name: publish, version: "1"}}
- {id: Read, needs: [Child], tool: read, input: {nested: ['${expression}']}}`,
      "child_output_unavailable",
      "/steps/1/input/nested/0"
    );
  });

  it("rejects transitive child output reads in Agent sub-prompts", () => {
    expectError(
      `${header}steps:
- {id: Child, routine: {name: publish, version: "1"}}
- {id: Middle, needs: [Child], tool: read}
- {id: Draft, needs: [Middle], agent: {name: writer, version: "1"}, prompt: "Describe \${states.Child.output.foo}"}`,
      "child_output_unavailable",
      "/steps/2/prompt"
    );
  });

  it.each([
    "${input.x",
    `\${process.env}`,
    `\${input.constructor}`,
    `\${item.name}`,
    `\${input.x = 3}`,
  ])("rejects invalid expressions: %s", (expression) => {
    expectError(
      JSON.stringify({
        apiVersion: "tulipfarm.ai/v1",
        kind: "Plan",
        name: "report",
        version: 1,
        steps: [{ id: "A", tool: "read", input: { nested: [expression] } }],
      }),
      "invalid_expression",
      "/steps/0/input/nested/0"
    );
  });

  it("rejects Agent prompt collisions and undeclared prompt references", () => {
    expectError(
      `${header}steps:\n- {id: A, agent: {name: writer, version: "1"}, prompt: write, input: {prompt: override}}`,
      "prompt_collision",
      "/steps/0/input/prompt"
    );
    expectError(
      `${header}steps:\n- {id: A, agent: {name: writer, version: "1"}, prompt: "\${states.B.output}"}`,
      "undeclared_state_reference",
      "/steps/0/prompt"
    );
  });

  it.each([
    `${header}steps: []\nsteps: []`,
    `${header}steps: []\n---\n${header}steps: []`,
    `${header}steps: !include remote.yaml`,
    `${header}steps: &cycle [*cycle]`,
    `${header}steps:\n- {id: A, tool: read, input: {number: .inf}}`,
    `${header}steps:\n- {id: A, tool: read, input: {1: value}}`,
  ])("rejects unsafe YAML: %s", (yaml) => {
    expectError(yaml, "YAML_PARSE_FAILED");
  });

  it("rejects unknown controls and YAML merge keys", () => {
    expectError(
      `${header}grants: [all]\nsteps:\n- {id: A, tool: read}`,
      "SCHEMA_VALIDATION_FAILED"
    );
    expectError(
      `${header}steps:\n- {id: A, tool: read, "<<": {identity: admin}}`,
      "SCHEMA_VALIDATION_FAILED"
    );
  });

  it("bounds UTF-8 source bytes and accepts exactly the boundary", () => {
    const minimal = `${header}steps:\n- {id: A, tool: read}\n#`;
    expect(
      compileYamlPlan(minimal + " ".repeat(YAML_PLAN_MAX_BYTES - Buffer.byteLength(minimal)))
    ).toBeDefined();
    expectError(minimal + "é".repeat(YAML_PLAN_MAX_BYTES / 2), "source_too_large", "");
  });

  it("requires reference versions, preserving authored pins instead of defaulting them", () => {
    expectError(`${header}steps:\n- {id: A, routine: {name: publish}}`, "SCHEMA_VALIDATION_FAILED");
    expectError(
      `${header}steps:\n- {id: A, agent: {name: writer}, prompt: write}`,
      "SCHEMA_VALIDATION_FAILED"
    );
  });
});
