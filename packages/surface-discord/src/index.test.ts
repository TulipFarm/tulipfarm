import { createSurfaceArtifact, surfaceActionKey } from "@tulipfarm/surface";
import { describe, expect, it } from "vitest";
import { discordMessageRenderer } from "./index";

describe("discordMessageRenderer", () => {
  it("renders actions as bounded native buttons", () => {
    const artifact = createSurfaceArtifact({
      id: "actions",
      component: { name: "Actions", version: "1.0" },
      props: { actions: [{ label: "Approve", action: { event: "record.approve" } }] },
      target: { channel: "discord", surface: "message" },
      audience: ["user:1"],
      classification: "internal",
    });
    expect(
      discordMessageRenderer.render(artifact, {
        destination: "channel:1",
        actionHandleFor: (action) => actionHandleFor({ event: "record.approve" }, action),
      })
    ).toMatchObject({
      content: "1. Approve",
      components: [{ components: [{ custom_id: "opaque", label: "Approve" }] }],
    });
  });

  it("truncates text to Discord's message limit", () => {
    const artifact = createSurfaceArtifact({
      id: "text",
      component: { name: "Text", version: "1.0" },
      props: { text: "a".repeat(8_000) },
      target: { channel: "discord", surface: "message" },
      audience: ["user:1"],
      classification: "internal",
    });
    expect(
      discordMessageRenderer.render(artifact, { destination: "channel:1" }).content
    ).toHaveLength(2_000);
  });

  it("splits ten actions into rows of five buttons", () => {
    const artifact = createSurfaceArtifact({
      id: "actions",
      component: { name: "Actions", version: "1.0" },
      props: {
        actions: Array.from({ length: 10 }, (_, index) => ({
          label: `Action ${index + 1}`,
          action: { event: `action.${index + 1}` },
        })),
      },
      target: { channel: "discord", surface: "message" },
      audience: ["user:1"],
      classification: "internal",
    });
    const payload = discordMessageRenderer.render(artifact, {
      destination: "channel:1",
      actionHandleFor: () => "opaque",
    });
    expect(payload.components?.map((row) => row.components.length)).toEqual([5, 5]);
  });
});

function actionHandleFor(
  expected: { readonly event: string },
  action: { readonly event: string }
): string {
  expect(surfaceActionKey(action)).toBe(surfaceActionKey(expected));
  return "opaque";
}
