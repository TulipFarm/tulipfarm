import type {
  ModelInvocationRequest,
  ModelOutput,
  ModelPort,
  ModelStreamChunk,
} from "@tulipfarm/agent-runtime";
import { textContent } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { ScriptExhaustedError, scriptedBinding } from "./scripted.ts";

const request: ModelInvocationRequest = {
  requestId: "scripted-1",
  modelProfileId: "eval",
  messages: [{ role: "user", content: textContent("Confirm the receipt.") }],
  tools: [],
};

const model = (script: readonly ModelOutput[]) =>
  scriptedBinding().create({
    id: "scripted-stream",
    tier: "l3",
    agent: "support",
    context: {},
    input: request.messages,
    expect: [],
    script,
  });

async function chunks(port: ModelPort) {
  if (port.stream === undefined) throw new Error("scripted binding lost streaming");
  const streamed: ModelStreamChunk[] = [];
  for await (const chunk of port.stream(request)) streamed.push(chunk);
  return streamed;
}

describe("scripted streaming", () => {
  it("splits text deterministically and consumes the same script as invoke, once per call", async () => {
    const output: ModelOutput = { kind: "text", text: "42.00 charged to 4111 1111 1111 1111" };
    const next: ModelOutput = { kind: "text", text: "Next response." };
    const port = model([output, next, output]);
    const streamed = await chunks(port);
    const deltas = streamed.flatMap((chunk) => (chunk.kind === "text_delta" ? [chunk.text] : []));
    expect(deltas).toEqual(["42.00 ch", "arged to", " 4111 11", "11 1111 ", "1111"]);
    expect(deltas.join("")).toBe(output.text);
    expect(streamed.at(-1)).toEqual({
      kind: "completed",
      result: {
        requestId: request.requestId,
        output,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costBasis: "priced" },
      },
    });
    expect((await port.invoke(request)).output).toEqual(next);
    expect(await chunks(port)).toEqual(streamed);
    await expect(chunks(port)).rejects.toThrow(ScriptExhaustedError);
    await expect(port.invoke(request)).rejects.toThrow(/5 time/);
  });

  it.each<ModelOutput>([
    { kind: "tool_calls", calls: [{ callId: "c1", name: "payment_record", arguments: {} }] },
    { kind: "structured", value: { amount: 42 } },
    { kind: "text", text: "" },
  ])("completes $kind output without inventing deltas", async (output) => {
    const streamed = await chunks(model([output]));
    expect(streamed).toHaveLength(1);
    expect(streamed[0]).toMatchObject({ kind: "completed", result: { output } });
  });
});
