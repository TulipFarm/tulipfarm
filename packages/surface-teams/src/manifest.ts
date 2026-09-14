import type { SurfaceRendererManifest } from "@tulipfarm/surface/client";

export const teamsMessageManifest: SurfaceRendererManifest = Object.freeze({
  renderer: "@tulipfarm/surface-teams/message",
  targets: [{ channel: "teams", surface: "message" }],
  components: {
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
    Divider: ["1.0"],
    Image: ["1.0"],
    MultiChoice: ["1.0"],
    Metric: ["1.0"],
    Timeline: ["1.0"],
    Comparison: ["1.0"],
    Breakdown: ["1.0"],
    Gauge: ["1.0"],
  },
  providerLimits: { cardBytes: 28_000, actions: 6 },
  interactionCapabilities: ["Action.Submit"],
} as const);
