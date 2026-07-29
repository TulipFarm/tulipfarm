import type { SurfaceRendererManifest } from "@tulipfarm/surface";

export const surfaceWebManifest: SurfaceRendererManifest = Object.freeze({
  renderer: "@tulipfarm/surface-web",
  targets: [{ channel: "web", surface: "chat" }],
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
    Form: ["1.0"],
    Chart: ["1.0"],
    ForceGraph: ["1.0"],
  },
  providerLimits: { artifactBytes: 256_000, tableRows: 100 },
  interactionCapabilities: [
    "actions",
    "choices",
    "forms",
    "charts",
    "force-graphs",
    "optimistic-update",
  ],
} as const);
