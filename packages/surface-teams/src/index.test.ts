import { createSurfaceArtifact } from "@tulipfarm/surface";
import { describe, expect, it } from "vitest";
import { teamsMessageRenderer } from "./index";

describe("teamsMessageRenderer", () => {
  it("renders an Adaptive Card with submit actions", () => {
    const artifact = createSurfaceArtifact({
      id: "choice",
      component: { name: "Choices", version: "1.0" },
      props: {
        question: "Continue?",
        choices: [{ label: "Yes", value: "yes" }],
        action: { event: "choice.submit" },
      },
      target: { channel: "teams", surface: "message" },
      audience: ["user:1"],
      classification: "internal",
    });
    const payload = teamsMessageRenderer.render(artifact, {
      destination: "chat:1",
      actionHandleFor: () => "opaque",
    });
    expect(payload.attachments[0].content.actions?.[0]).toMatchObject({
      type: "Action.Submit",
      title: "Yes",
      data: { action: "opaque", value: "yes" },
    });
  });
});
