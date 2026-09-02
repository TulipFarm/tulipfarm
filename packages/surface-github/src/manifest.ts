import type { SurfaceRendererManifest } from "@tulipfarm/surface/client";

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
  Metric: ["1.0"],
  Timeline: ["1.0"],
  Comparison: ["1.0"],
  Breakdown: ["1.0"],
  Gauge: ["1.0"],
} as const;

export const githubCommentManifest: SurfaceRendererManifest = Object.freeze({
  renderer: "@tulipfarm/surface-github/comment",
  targets: [{ channel: "github", surface: "comment" }],
  components: { ...commonComponents, Choices: ["1.0"] },
  providerLimits: { markdownCharacters: 65_535, requestedActions: 3 },
  interactionCapabilities: ["commands", "reactions", "comment-update"],
} as const);

export const githubCheckRunManifest: SurfaceRendererManifest = Object.freeze({
  renderer: "@tulipfarm/surface-github/check-run",
  targets: [{ channel: "github", surface: "check-run" }],
  components: commonComponents,
  providerLimits: { markdownCharacters: 65_535, requestedActions: 3 },
  interactionCapabilities: ["requested_action", "check-rerequested"],
} as const);
