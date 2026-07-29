import { createSurfaceArtifact } from "@tulipfarm/surface";
import { describe, expect, it } from "vitest";
import { slackMessageRenderer } from "./index";

describe("slackMessageRenderer", () => {
  it("renders Block Kit actions with opaque handles", () => {
    const artifact = createSurfaceArtifact({
      id: "approval",
      component: { name: "Actions", version: "1.0" },
      props: { actions: [{ label: "Approve", action: { event: "record.approve" } }] },
      target: { channel: "slack", surface: "message" },
      audience: ["user:1"],
      classification: "internal",
    });
    const payload = slackMessageRenderer.render(artifact, {
      destination: "C1",
      actionHandleFor: () => "opaque",
    });
    expect(payload.blocks[0]?.elements?.[0]).toMatchObject({
      action_id: "opaque",
      value: "opaque",
    });
  });
});
