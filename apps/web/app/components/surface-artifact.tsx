import {
  type ResolvedSurfaceViewNode,
  type SurfaceArtifact as SurfaceArtifactValue,
  type SurfaceCodeViewPayload,
  surfaceActionKey,
  surfaceActionsForArtifact,
} from "@tulipfarm/surface/client";
import { SurfaceCodeView } from "@tulipfarm/surface-web/code-view";
import { SurfaceCompositionView, SurfaceView } from "@tulipfarm/surface-web/view";
import { useEffect, useState } from "react";
import { apiGet } from "~/lib/api";

export interface SurfaceArtifactProps {
  readonly artifact?: SurfaceArtifactValue;
  readonly artifactId: string;
  // Absent on a live `surface.emitted` event (the wire names only the id) — the fetch below omits
  // the query param, which resolves to the latest revision server-side.
  readonly revision?: number;
  readonly resolvedView?: ResolvedSurfaceViewNode;
  readonly codeView?: SurfaceCodeViewPayload;
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
  codeView: initialCodeView,
  actionHandles: initialActionHandles,
  onInteraction,
}: SurfaceArtifactProps) {
  const [artifact, setArtifact] = useState(initialArtifact);
  const [actionHandles, setActionHandles] = useState(initialActionHandles ?? {});
  const [resolvedView, setResolvedView] = useState(initialResolvedView);
  const [codeView, setCodeView] = useState(initialCodeView);
  // A code view and a resolved tree are two shapes of the same answer, so one flag covers both;
  // tracking only the tree would refetch a code-backed artifact forever.
  const [presentationLoaded, setPresentationLoaded] = useState(
    initialResolvedView !== undefined || initialCodeView !== undefined
  );
  const [handlesLoaded, setHandlesLoaded] = useState(initialActionHandles !== undefined);
  useEffect(() => {
    if (!initialArtifact) return;
    setArtifact(initialArtifact);
    setActionHandles(initialActionHandles ?? {});
    setResolvedView(initialResolvedView);
    setCodeView(initialCodeView);
    setPresentationLoaded(initialResolvedView !== undefined || initialCodeView !== undefined);
    setHandlesLoaded(initialActionHandles !== undefined);
  }, [initialArtifact, initialActionHandles, initialResolvedView, initialCodeView]);
  useEffect(() => {
    const needsHandles =
      artifact && surfaceActionsForArtifact(artifact).some((action) => !action.disabled);
    const needsPresentation =
      artifact?.component.name.startsWith("business.") && !presentationLoaded;
    if (artifact && (!needsHandles || handlesLoaded) && !needsPresentation) return;
    let active = true;
    void apiGet<{
      artifact: SurfaceArtifactValue;
      actionHandles: Readonly<Record<string, string>>;
      resolvedView?: ResolvedSurfaceViewNode;
      codeView?: SurfaceCodeViewPayload;
    }>(
      `/api/v1/surfaces/${encodeURIComponent(artifactId)}${revision === undefined ? "" : `?revision=${revision}`}`
    ).then((value) => {
      if (active) {
        setArtifact(value.artifact);
        setActionHandles(value.actionHandles);
        setResolvedView(value.resolvedView);
        setCodeView(value.codeView);
        setPresentationLoaded(true);
        setHandlesLoaded(true);
      }
    });
    return () => {
      active = false;
    };
  }, [artifact, artifactId, handlesLoaded, presentationLoaded, revision]);
  const actionHandleFor = (action: Parameters<typeof surfaceActionKey>[0]) =>
    actionHandles[surfaceActionKey(action)];
  return artifact && codeView ? (
    <SurfaceCodeView
      artifact={artifact}
      module={codeView.compiled}
      onInteraction={onInteraction}
      actionHandleFor={actionHandleFor}
    />
  ) : artifact && resolvedView ? (
    <SurfaceCompositionView
      artifact={artifact}
      view={resolvedView}
      onInteraction={onInteraction}
      actionHandleFor={actionHandleFor}
    />
  ) : artifact && !artifact.component.name.startsWith("business.") ? (
    <SurfaceView
      artifact={artifact}
      onInteraction={onInteraction}
      actionHandleFor={actionHandleFor}
    />
  ) : artifact && presentationLoaded ? (
    <div role="alert">Published presentation component unavailable.</div>
  ) : (
    <div role="status">Loading presentation…</div>
  );
}
