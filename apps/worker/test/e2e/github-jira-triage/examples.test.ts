import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileRoutine } from "@tulipfarm/run-kernel";
import {
  DEFINITION_REGISTRATIONS,
  parseYamlDocument,
  routine as routineSchema,
  SchemaRegistry,
} from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { EXAMPLES_DIR, IDENTITY_CEILING, triageCatalog } from "./harness";

function example(file: string): unknown {
  return parseYamlDocument(readFileSync(join(EXAMPLES_DIR, file), "utf8"));
}

const registry = new SchemaRegistry(DEFINITION_REGISTRATIONS);

describe("github-issue-triage example Soul artifacts", () => {
  it("validates every authored definition against its published schema", () => {
    for (const file of ["agent.yaml", "integration.yaml", "access-grant.yaml"]) {
      expect(() => registry.validate(example(file))).not.toThrow();
    }
    expect(() => routineSchema.validateRoutineDefinition(example("routine.yaml"))).not.toThrow();
  });

  it("compiles the Routine into a bounded graph under an identity ceiling", () => {
    const definition = routineSchema.validateRoutineDefinition(example("routine.yaml")).document;
    const compiled = compileRoutine(definition, { identityCeiling: IDENTITY_CEILING });

    expect(compiled.start).toBe("ReadIssue");
    expect(compiled.order).toEqual([
      "ReadIssue",
      "FindDuplicates",
      "ClassifyIssue",
      "RouteOutcome",
      "ReplyDuplicate",
      "ApproveClose",
      "CloseIssue",
      "ApplyLabels",
      "CheckAvailability",
      "CreateTicket",
      "ApproveAssignment",
      "AssignIssue",
      "ReplyTriaged",
    ]);
  });

  it("routes every external mutation through a published ToolContract", () => {
    const definition = routineSchema.validateRoutineDefinition(example("routine.yaml")).document;
    const compiled = compileRoutine(definition, { identityCeiling: IDENTITY_CEILING });
    const catalog = triageCatalog();

    for (const state of compiled.states.values()) {
      if (state.type !== "tool") continue;
      const authored = state.definition as unknown as {
        toolRef: { name: string; version: string };
      };
      expect(catalog.get(authored.toolRef.name, authored.toolRef.version)).toBeDefined();
    }
  });

  it("gates the irreversible close and the assignment behind Approval States", () => {
    const definition = routineSchema.validateRoutineDefinition(example("routine.yaml")).document;
    const compiled = compileRoutine(definition, { identityCeiling: IDENTITY_CEILING });

    const approvals = [...compiled.states.values()].filter((state) => state.type === "approval");
    expect(approvals.map((state) => state.name)).toEqual(["ApproveClose", "ApproveAssignment"]);
    expect(approvals.map((state) => state.transition)).toEqual(["CloseIssue", "AssignIssue"]);
  });

  it("never carries Secret material in an authored artifact", () => {
    for (const file of ["routine.yaml", "agent.yaml", "integration.yaml", "access-grant.yaml"]) {
      const source = readFileSync(join(EXAMPLES_DIR, file), "utf8");
      expect(source).not.toMatch(/gh[ps]_[A-Za-z0-9]/);
      for (const reference of source.match(/secret:\/\/\S+/g) ?? []) {
        expect(reference).toMatch(/^secret:\/\/integrations\//);
      }
    }
  });
});
