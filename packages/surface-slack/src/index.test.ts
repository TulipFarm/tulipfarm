import { createSurfaceArtifact } from "@tulipfarm/surface";
import { describe, expect, it } from "vitest";
import { slackMessageRenderer, slackModalRenderer } from "./index";

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

  it("renders Divider as a divider block", () => {
    const artifact = createSurfaceArtifact({
      id: "divider",
      component: { name: "Divider", version: "1.0" },
      props: {},
      target: { channel: "slack", surface: "message" },
      audience: ["user:1"],
      classification: "internal",
    });
    const payload = slackMessageRenderer.render(artifact, { destination: "C1" });
    expect(payload.blocks[0]).toEqual({ type: "divider" });
  });

  it("renders Image as an image block", () => {
    const artifact = createSurfaceArtifact({
      id: "image",
      component: { name: "Image", version: "1.0" },
      props: { url: "https://example.com/chart.png", altText: "Revenue chart", title: "This week" },
      target: { channel: "slack", surface: "message" },
      audience: ["user:1"],
      classification: "internal",
    });
    const payload = slackMessageRenderer.render(artifact, { destination: "C1" });
    expect(payload.blocks[0]).toMatchObject({
      type: "image",
      image_url: "https://example.com/chart.png",
      alt_text: "Revenue chart",
      title: { type: "plain_text", text: "This week" },
    });
  });

  it("renders MultiChoice as a multi_static_select", () => {
    const artifact = createSurfaceArtifact({
      id: "regions",
      component: { name: "MultiChoice", version: "1.0" },
      props: {
        question: "Which regions?",
        choices: [{ label: "US", value: "us" }],
        action: { event: "regions.choose" },
      },
      target: { channel: "slack", surface: "message" },
      audience: ["user:1"],
      classification: "internal",
    });
    const payload = slackMessageRenderer.render(artifact, {
      destination: "C1",
      actionHandleFor: () => "opaque",
    });
    expect(payload.blocks[0]?.accessory).toMatchObject({
      type: "multi_static_select",
      action_id: "opaque",
    });
  });
});

describe("slackModalRenderer", () => {
  it("renders each Form field with its typed Slack element, not always plain_text_input", () => {
    const artifact = createSurfaceArtifact({
      id: "form",
      component: { name: "Form", version: "1.0" },
      props: {
        fields: [
          { name: "email", label: "Email", input: "email", required: true },
          { name: "plan", label: "Plan", input: "select", options: ["Basic", "Pro"] },
          { name: "notify", label: "Notify", input: "checkbox", options: ["Email", "SMS"] },
          { name: "region", label: "Region", input: "radio", options: ["US", "EU"] },
          { name: "tags", label: "Tags", input: "multiselect", options: ["A", "B"] },
          { name: "start", label: "Start", input: "date" },
          { name: "notes", label: "Notes", input: "textarea" },
        ],
        submit: "Continue",
        action: { event: "contact.submit" },
      },
      target: { channel: "slack", surface: "modal" },
      audience: ["user:1"],
      classification: "internal",
    });
    const payload = slackModalRenderer.render(artifact, {
      destination: "C1",
      actionHandleFor: () => "opaque",
    });
    const view = payload.view as { blocks: Array<{ element: { type: string } }> };
    expect(view.blocks.map((block) => block.element.type)).toEqual([
      "email_text_input",
      "static_select",
      "checkboxes",
      "radio_buttons",
      "multi_static_select",
      "datepicker",
      "plain_text_input",
    ]);
    expect(view.blocks[6]?.element).toMatchObject({ multiline: true });
  });
});
