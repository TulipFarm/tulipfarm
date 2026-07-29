import type { SurfaceRendererManifest } from "@tulipfarm/surface";

const commonComponents = {
  Text: ["1.0"],
  Heading: ["1.0"],
  Section: ["1.0"],
  Card: ["1.0"],
  Status: ["1.0"],
  Alert: ["1.0"],
  List: ["1.0"],
  RecordDetail: ["1.0"],
  RecordTable: ["1.0"],
  Actions: ["1.0"],
  Choices: ["1.0"],
} as const;

export const slackMessageManifest: SurfaceRendererManifest = Object.freeze({
  renderer: "@tulipfarm/surface-slack/message",
  targets: [{ channel: "slack", surface: "message" }],
  components: commonComponents,
  providerLimits: { blocks: 50, textCharacters: 3_000 },
  interactionCapabilities: ["block_actions", "chat.update"],
} as const);

export const slackModalManifest: SurfaceRendererManifest = Object.freeze({
  renderer: "@tulipfarm/surface-slack/modal",
  targets: [{ channel: "slack", surface: "modal" }],
  components: { ...commonComponents, Form: ["1.0"] },
  providerLimits: { blocks: 50, textCharacters: 3_000 },
  interactionCapabilities: ["block_actions", "view_submission", "chat.update"],
} as const);
