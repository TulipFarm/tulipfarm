import { createSurfaceArtifact } from "@tulipfarm/surface";
import { describe, expect, it } from "vitest";
import { telegramMessageRenderer } from "./index";

describe("telegramMessageRenderer", () => {
  it("renders a readable numbered choice list and inline keyboard", () => {
    const artifact = createSurfaceArtifact({
      id: "choice",
      component: { name: "Choices", version: "1.0" },
      props: {
        question: "Continue?",
        choices: [{ label: "Yes", value: "yes" }],
        action: { event: "choice.submit" },
      },
      target: { channel: "telegram", surface: "message" },
      audience: ["user:1"],
      classification: "internal",
    });
    const payload = telegramMessageRenderer.render(artifact, {
      destination: "chat:1",
      actionHandleFor: () => "opaque",
    });
    expect(payload.text).toBe("Continue?\n1. Yes");
    expect(payload.reply_markup?.inline_keyboard[0]?.[0]).toEqual({
      text: "Yes",
      callback_data: "opaque",
    });
  });

  it("limits callback data by UTF-8 bytes", () => {
    const artifact = createSurfaceArtifact({
      id: "actions",
      component: { name: "Actions", version: "1.0" },
      props: { actions: [{ label: "Run", action: { event: "task.run" } }] },
      target: { channel: "telegram", surface: "message" },
      audience: ["user:1"],
      classification: "internal",
    });
    const payload = telegramMessageRenderer.render(artifact, {
      destination: "chat:1",
      actionHandleFor: () => "😀".repeat(40),
    });
    const callback = payload.reply_markup?.inline_keyboard[0]?.[0].callback_data ?? "";
    expect(Buffer.byteLength(callback, "utf8")).toBeLessThanOrEqual(64);
  });
});
