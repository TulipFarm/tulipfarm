import type { SurfaceRendererManifest } from "@tulipfarm/surface";

export const telegramManifest: SurfaceRendererManifest = Object.freeze({
  renderer: "@tulipfarm/surface-telegram",
  targets: [{ channel: "telegram", surface: "message" }],
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
    Metric: ["1.0"],
    Timeline: ["1.0"],
    Comparison: ["1.0"],
    Breakdown: ["1.0"],
    Gauge: ["1.0"],
  },
  providerLimits: { textCharacters: 4_096, callbackBytes: 64 },
  interactionCapabilities: ["callback_query", "editMessageText"],
} as const);
