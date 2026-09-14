import { createSurfaceArtifact } from "@tulipfarm/surface";
import { describe, expect, it } from "vitest";
import { googleChatMessageRenderer } from "./index";

describe("googleChatMessageRenderer", () => {
  it("renders choices as card buttons", () => {
    const artifact = createSurfaceArtifact({
      id: "choice",
      component: { name: "Choices", version: "1.0" },
      props: {
        question: "Continue?",
        choices: [{ label: "Yes", value: "yes" }],
        action: { event: "choice.submit" },
      },
      target: { channel: "google-chat", surface: "message" },
      audience: ["user:1"],
      classification: "internal",
    });
    const payload = googleChatMessageRenderer.render(artifact, {
      destination: "space:1",
      actionHandleFor: () => "opaque",
    });
    expect(payload.cardsV2?.[0].card.sections[0].widgets[0].buttonList.buttons[0]).toMatchObject({
      text: "Yes",
      onClick: { action: { function: "opaque" } },
    });
  });
});
