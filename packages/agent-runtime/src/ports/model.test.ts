import { textContent } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import type { ModelPort } from "./model";

describe("ModelPort", () => {
  it("uses provider-neutral request and response contracts", async () => {
    const port: ModelPort = {
      invoke: async (request) => ({
        requestId: request.requestId,
        output: { kind: "text", text: "ok" },
        usage: { inputTokens: 2, outputTokens: 1 },
      }),
    };

    await expect(
      port.invoke({
        requestId: "request-1",
        modelProfileId: "profile-1",
        messages: [{ role: "user", content: textContent("hello") }],
      })
    ).resolves.toMatchObject({ requestId: "request-1", output: { text: "ok" } });
  });
});
