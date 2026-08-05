import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelPort,
  ToolDispatchPort,
} from "@tulipfarm/agent-runtime";
import { describe, expect, it } from "vitest";
import { agentLoopTarget, modelTarget } from "./targets";
import type { EvalCase } from "./types";

function scriptedModel(outputs: readonly ModelInvocationResult["output"][]): ModelPort {
  let index = 0;
  return {
    async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
      const output = outputs[index];
      index += 1;
      if (output === undefined) throw new Error("model called more times than scripted");
      return { requestId: request.requestId, output, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

const succeedingDispatch: ToolDispatchPort = {
  async dispatch(request) {
    return { status: "succeeded", callId: request.callId, output: { done: true } };
  },
};

const promptCase: EvalCase = {
  caseId: "c1",
  version: "1",
  severity: "blocking",
  input: { prompt: "make a task" },
};

describe("modelTarget", () => {
  it("maps a text result", async () => {
    const target = modelTarget({ model: scriptedModel([{ kind: "text", text: "hello" }]) });
    const output = await target.execute({ evalCase: promptCase });
    expect(output.text).toBe("hello");
    expect(output.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it("maps a tool-call result", async () => {
    const target = modelTarget({
      model: scriptedModel([
        {
          kind: "tool_calls",
          calls: [{ callId: "a", name: "record_create", arguments: { title: "X" } }],
        },
      ]),
    });
    const output = await target.execute({ evalCase: promptCase });
    expect(output.toolCalls).toEqual([{ name: "record_create", arguments: { title: "X" } }]);
  });
});

describe("agentLoopTarget", () => {
  it("drives the real loop, capturing tool calls and final text", async () => {
    const model = scriptedModel([
      {
        kind: "tool_calls",
        calls: [{ callId: "a", name: "record_create", arguments: { title: "SSL" } }],
      },
      { kind: "text", text: "created the task" },
    ]);
    const target = agentLoopTarget({
      model,
      dispatch: succeedingDispatch,
      tools: [{ name: "record_create", inputSchema: { type: "object" } }],
    });
    const output = await target.execute({ evalCase: promptCase });
    expect(output.toolCalls).toEqual([{ name: "record_create", arguments: { title: "SSL" } }]);
    expect(output.text).toBe("created the task");
    expect(output.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
  });
});
