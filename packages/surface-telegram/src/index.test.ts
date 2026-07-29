import { createSurfaceArtifact } from "@tulipfarm/surface";
import { describe, expect, it } from "vitest";
import { telegramRenderer } from "./index";

describe("telegramRenderer", () => {
  it("uses short callback handles", () => {
    const artifact = createSurfaceArtifact({
      id: "choice",
      component: { name: "Choices", version: "1.0" },
      props: {
        question: "Choose",
        choices: [{ label: "One", value: "one" }],
        action: { event: "choice.select" },
      },
      target: { channel: "telegram", surface: "message" },
      audience: ["user:1"],
      classification: "internal",
    });
    const payload = telegramRenderer.render(artifact, {
      destination: "1",
      actionHandleFor: () => "h_123",
    });
    expect(payload.reply_markup?.inline_keyboard[0]?.[0]?.callback_data).toBe("h_123");
  });
});
