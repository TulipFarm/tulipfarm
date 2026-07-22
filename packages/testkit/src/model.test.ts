import { describe, expect, it } from "vitest";
import { FakeModelAdapter } from "./model";

type ModelRequest = { messages: string[]; model: string };
type ModelResponse = { text: string; toolName?: string };

describe("FakeModelAdapter", () => {
  it("returns scripted responses in order and records calls", async () => {
    const model = new FakeModelAdapter<ModelRequest, ModelResponse>();
    model.respondWith({ text: "inspect", toolName: "record_get" });
    model.respondUsing(({ request, callIndex }) => ({
      text: `${callIndex}:${request.messages.at(-1)}`,
    }));

    await expect(model.invoke({ messages: ["hello"], model: "test" })).resolves.toEqual({
      text: "inspect",
      toolName: "record_get",
    });
    await expect(model.invoke({ messages: ["result"], model: "test" })).resolves.toEqual({
      text: "1:result",
    });
    expect(model.calls).toEqual([
      { messages: ["hello"], model: "test" },
      { messages: ["result"], model: "test" },
    ]);
    expect(() => model.assertDrained()).not.toThrow();
  });

  it("surfaces scripted provider failures and rejects unscripted calls", async () => {
    const model = new FakeModelAdapter<ModelRequest, ModelResponse>();
    model.failWith(new Error("provider unavailable"));

    await expect(model.invoke({ messages: [], model: "test" })).rejects.toThrow(
      "provider unavailable"
    );
    await expect(model.invoke({ messages: [], model: "test" })).rejects.toThrow(
      "unexpected model invocation"
    );
  });

  it("reports unconsumed script steps", () => {
    const model = new FakeModelAdapter<ModelRequest, ModelResponse>();
    model.respondWith({ text: "unused" });

    expect(() => model.assertDrained()).toThrow("1 unconsumed");
  });
});
