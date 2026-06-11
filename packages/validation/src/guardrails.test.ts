import { describe, expect, it } from "vitest";
import { TulipFarmValidationError } from "./error";
import { type GuardrailsConfig, validateGuardrailsConfig } from "./guardrails";

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
