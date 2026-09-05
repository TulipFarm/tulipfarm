import { validateSurfaceArtifact } from "@tulipfarm/surface";
import type { SurfaceRenderer } from "@tulipfarm/surface/client";
import { sameTarget, targetKey } from "@tulipfarm/surface/client";
import type { ReactElement } from "react";
import { surfaceWebManifest } from "./manifest";
import { SurfaceView } from "./view";

export { SurfaceCodeView, type SurfaceCodeViewProps } from "./code-view";
export type { SurfaceCompositionProps, SurfaceWebProps } from "./primitives";
export { SurfaceCompositionView, SurfaceView } from "./view";

const target = { channel: "web", surface: "chat" } as const;

export const surfaceWebRenderer: SurfaceRenderer<ReactElement> = {
  target,
  manifest: surfaceWebManifest,
  preflight: (artifact) => [
    ...validateSurfaceArtifact(artifact, [], surfaceWebManifest),
    ...(!sameTarget(artifact.target, target)
      ? [
          {
            code: "component_unsupported" as const,
            path: "/target",
            message: "Artifact target does not match the web renderer.",
          },
        ]
      : []),
  ],
  render: (artifact, context) => {
    const issues = surfaceWebRenderer.preflight(artifact);
    if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join("; "));
    return <SurfaceView artifact={artifact} actionHandleFor={context.actionHandleFor} />;
  },
  update: (_previous, artifact, context) => surfaceWebRenderer.render(artifact, context),
};

export { targetKey };
