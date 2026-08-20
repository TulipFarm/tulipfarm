import { describe, expect, it } from "vitest";
import { TulipFarmValidationError } from "./error";
import {
  GUARDRAIL_STAGE_BY_GUARD,
  type GuardrailsConfig,
  guardrailStageFor,
  validateGuardrailsConfig,
} from "./guardrails";

describe("validateGuardrailsConfig", () => {
  it("accepts a valid full config across all three stages", () => {
    const config: GuardrailsConfig = {
      input: [{ guard: "prompt_injection", sensitivity: "medium" }],
      "tool-call": [{ guard: "tool_blocklist", block: ["run_command", "fs_*"] }],
      output: [{ guard: "content_filter", patterns: ["credit_card", "ssn", "api_key", "email"] }],
    };
    expect(validateGuardrailsConfig(config)).toEqual(config);
  });

  it("rejects an unknown guard name", () => {
    expect(() => validateGuardrailsConfig({ input: [{ guard: "ai_disclosure" }] })).toThrow(
      TulipFarmValidationError
    );
  });

  it("rejects a guard placed in the wrong stage", () => {
    expect(() =>
      validateGuardrailsConfig({
        input: [{ guard: "content_filter", patterns: ["ssn"] }],
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("rejects an invalid sensitivity enum value", () => {
    expect(() =>
      validateGuardrailsConfig({
        input: [{ guard: "prompt_injection", sensitivity: "extreme" }],
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("rejects additionalProperties", () => {
    expect(() =>
      validateGuardrailsConfig({
        input: [{ guard: "prompt_injection", sensitivity: "low" }],
        unexpected: true,
      })
    ).toThrow(TulipFarmValidationError);
  });
});

describe("guardrailStageFor", () => {
  it("names the only stage each guard validates in", () => {
    for (const [guard, stage] of Object.entries(GUARDRAIL_STAGE_BY_GUARD)) {
      const sample =
        guard === "content_filter"
          ? { guard, patterns: ["ssn"] }
          : guard === "tool_blocklist"
            ? { guard, block: ["record_delete"] }
            : { guard };
      expect(guardrailStageFor(guard)).toBe(stage);
      expect(validateGuardrailsConfig({ [stage]: [sample] })).toEqual({ [stage]: [sample] });
    }
  });

  it("returns undefined for a guard no stage union admits", () => {
    expect(guardrailStageFor("ai_disclosure")).toBeUndefined();
    expect(guardrailStageFor("constructor")).toBeUndefined();
  });
});
