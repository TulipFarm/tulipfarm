import { describe, expect, it } from "vitest";
import type { ToolCallResult } from "../tools/types";
import { shouldStopToolLoop } from "./turn-helpers";

function toolStep(toolName: string, toolCallId = "call-1") {
  return [{ toolCalls: [{ toolName, toolCallId }] }];
}

describe("shouldStopToolLoop", () => {
  it("pauses when request_input successfully creates its presentation", () => {
    const results = new Map<string, ToolCallResult>([
      ["call-1", { success: true, data: { artifactId: "surface-1" } }],
    ]);

    expect(shouldStopToolLoop(toolStep("request_input"), results, 10)).toBe(true);
  });

  it("continues when request_input fails to create its presentation", () => {
    const results = new Map<string, ToolCallResult>([
      [
        "call-1",
        {
          success: false,
          error: { code: "internal_error", message: "Presentation unavailable." },
        },
      ],
    ]);

    expect(shouldStopToolLoop(toolStep("request_input"), results, 10)).toBe(false);
  });

  it("still stops at the Tool step budget", () => {
    expect(shouldStopToolLoop(toolStep("ordinary_tool"), new Map(), 1)).toBe(true);
  });
});
