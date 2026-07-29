import {
  type ResolvedSurfaceViewNode,
  type SurfaceArtifact as SurfaceArtifactValue,
  surfaceActionKey,
  surfaceActionsForArtifact,
} from "@tulipfarm/surface";
import { SurfaceCompositionView, SurfaceView } from "@tulipfarm/surface-web";
import { useEffect, useState } from "react";
import { apiGet } from "~/lib/api";

export interface SurfaceArtifactProps {
  readonly artifact?: SurfaceArtifactValue;
  readonly artifactId: string;
  readonly revision: number;
  readonly resolvedView?: ResolvedSurfaceViewNode;
  readonly actionHandles?: Readonly<Record<string, string>>;
  readonly onInteraction?: (
    handle: string,
    input: Readonly<Record<string, unknown>>
  ) => void | Promise<void>;
}

export function SurfaceArtifact({
  artifact: initialArtifact,
  artifactId,
  revision,
  resolvedView: initialResolvedView,
  actionHandles: initialActionHandles,
  onInteraction,
}: SurfaceArtifactProps) {
  const [artifact, setArtifact] = useState(initialArtifact);
  const [actionHandles, setActionHandles] = useState(initialActionHandles ?? {});
  const [resolvedView, setResolvedView] = useState(initialResolvedView);
  const [resolvedViewLoaded, setResolvedViewLoaded] = useState(initialResolvedView !== undefined);
  const [handlesLoaded, setHandlesLoaded] = useState(initialActionHandles !== undefined);
  useEffect(() => {
    if (!initialArtifact) return;
    setArtifact(initialArtifact);
    setActionHandles(initialActionHandles ?? {});
    setResolvedView(initialResolvedView);
    setResolvedViewLoaded(initialResolvedView !== undefined);
    setHandlesLoaded(initialActionHandles !== undefined);
  }, [initialArtifact, initialActionHandles, initialResolvedView]);
  useEffect(() => {
    const needsHandles =
      artifact && surfaceActionsForArtifact(artifact).some((action) => !action.disabled);
    const needsResolvedView =
      artifact?.component.name.startsWith("business.") && !resolvedView && !resolvedViewLoaded;
    if (artifact && (!needsHandles || handlesLoaded) && !needsResolvedView) return;
    let active = true;
    void apiGet<{
      artifact: SurfaceArtifactValue;
      actionHandles: Readonly<Record<string, string>>;
      resolvedView?: ResolvedSurfaceViewNode;
    }>(`/api/v1/surfaces/${encodeURIComponent(artifactId)}?revision=${revision}`).then((value) => {
      if (active) {
        setArtifact(value.artifact);
        setActionHandles(value.actionHandles);
        setResolvedView(value.resolvedView);
        setResolvedViewLoaded(true);
        setHandlesLoaded(true);
      }
    });
    return () => {
      active = false;
    };
  }, [artifact, artifactId, handlesLoaded, resolvedView, resolvedViewLoaded, revision]);
  return artifact && resolvedView ? (
    <SurfaceCompositionView
      artifact={artifact}
      view={resolvedView}
      onInteraction={onInteraction}
      actionHandleFor={(action) => actionHandles[surfaceActionKey(action)]}
    />
  ) : artifact && !artifact.component.name.startsWith("business.") ? (
    <SurfaceView
      artifact={artifact}
      onInteraction={onInteraction}
      actionHandleFor={(action) => actionHandles[surfaceActionKey(action)]}
    />
  ) : artifact && resolvedViewLoaded ? (
    <div role="alert">Published presentation component unavailable.</div>
  ) : (
    <div role="status">Loading presentation…</div>
  );
}
