import { describe, expect, it } from "vitest";
import { AUTONOMY_VALUES, validateAgentFrontmatter } from "./agent";
import { TulipFarmValidationError } from "./error";

describe("validateAgentFrontmatter", () => {
  it("returns the typed object for fully-populated valid frontmatter", () => {
    const fm = {
      label: "Task Planner",
      domain: "engineering",
      description: "Plans and sequences work.",
      model: "claude-opus-4-8",
      autonomy: "approval-required",
      capabilityRestrictions: {
        tools: { allowMutating: false, deny: ["record_delete"] },
        records: { actions: { allow: ["list", "search", "read"], deny: ["delete"] } },
        resourceTypes: { actions: { allow: ["list", "read"], deny: ["create", "update"] } },
      },
      placeholder: ["Plan next sprint..."],
      suggestions: ["Plan next sprint", "Triage the backlog"],
    };
    const result = validateAgentFrontmatter(fm);
    expect(result).toEqual(fm);
    expect(result.autonomy).toBe("approval-required");
  });

  it("accepts empty frontmatter (all fields optional)", () => {
    expect(validateAgentFrontmatter({})).toEqual({});
  });

  it("accepts a partial subset of fields", () => {
    expect(() => validateAgentFrontmatter({ domain: "ops" })).not.toThrow();
  });

  it("accepts capability restrictions for tool, Record, and Resource type actions", () => {
    const result = validateAgentFrontmatter({
      capabilityRestrictions: {
        tools: { allow: ["record_list", "record_get"], allowMutating: false },
        records: {
          resourceTypes: ["ticket"],
          actions: { allow: ["list", "read"], deny: ["delete"] },
        },
        resourceTypes: { names: ["ticket"], actions: { allow: ["list", "read"] } },
      },
    });

    expect(result.capabilityRestrictions?.records?.actions?.deny).toEqual(["delete"]);
  });

  it("accepts every autonomy enum value", () => {
    for (const a of AUTONOMY_VALUES) {
      expect(() => validateAgentFrontmatter({ autonomy: a })).not.toThrow();
    }
  });

  it("rejects an unknown autonomy value (boundary agent, path /autonomy)", () => {
    expect.assertions(4);
    expect(() => validateAgentFrontmatter({ autonomy: "banana" })).toThrow(
      TulipFarmValidationError
    );
    try {
      validateAgentFrontmatter({ autonomy: "banana" });
    } catch (err) {
      expect(err).toBeInstanceOf(TulipFarmValidationError);
      expect((err as TulipFarmValidationError).boundary).toBe("agent");
      expect((err as TulipFarmValidationError).path).toBe("/autonomy");
    }
  });

  it("rejects unknown frontmatter keys (strict — additionalProperties:false)", () => {
    expect.assertions(3);
    expect(() => validateAgentFrontmatter({ autonimy: "full" })).toThrow(TulipFarmValidationError);
    try {
      validateAgentFrontmatter({ author: "dhruv" });
    } catch (err) {
      expect((err as TulipFarmValidationError).boundary).toBe("agent");
      expect((err as TulipFarmValidationError).message).toMatch(/additional/i);
    }
  });

  it("rejects name and id in frontmatter (name = directory, no id field)", () => {
    expect(() => validateAgentFrontmatter({ name: "task-planner" })).toThrow(
      TulipFarmValidationError
    );
    expect(() => validateAgentFrontmatter({ id: "agt-1" })).toThrow(TulipFarmValidationError);
  });

  it("rejects placeholder / suggestions that are not string arrays", () => {
    expect(() => validateAgentFrontmatter({ placeholder: "nope" })).toThrow(
      TulipFarmValidationError
    );
    expect(() => validateAgentFrontmatter({ suggestions: [1, 2] })).toThrow(
      TulipFarmValidationError
    );
  });

  it("rejects unknown capability restriction actions and keys", () => {
    expect(() =>
      validateAgentFrontmatter({
        capabilityRestrictions: { records: { actions: { deny: ["destroy"] } } },
      })
    ).toThrow(TulipFarmValidationError);
    expect(() =>
      validateAgentFrontmatter({ capabilityRestrictions: { tools: { denied: ["record_delete"] } } })
    ).toThrow(TulipFarmValidationError);
  });

  it("rejects a model id containing whitespace", () => {
    expect(() => validateAgentFrontmatter({ model: "gpt 4o" })).toThrow(TulipFarmValidationError);
    expect(() => validateAgentFrontmatter({ model: "quick" })).not.toThrow();
  });

  it("wraps AJV failures as TulipFarmValidationError (AJV-backed, never Zod)", () => {
    expect(() => validateAgentFrontmatter({ autonomy: 123 })).toThrow(TulipFarmValidationError);
  });
});
