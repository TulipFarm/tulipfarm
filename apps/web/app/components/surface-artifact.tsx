import {
  type ResolvedSurfaceViewNode,
  type SurfaceArtifact as SurfaceArtifactValue,
  type SurfaceCodeViewPayload,
  surfaceActionKey,
  surfaceActionsForArtifact,
} from "@tulipfarm/surface/client";
import { SurfaceCodeView } from "@tulipfarm/surface-web/code-view";
import { SurfaceCompositionView, SurfaceView } from "@tulipfarm/surface-web/view";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { apiGet } from "~/lib/api";

export interface SurfaceArtifactProps {
  readonly artifact?: SurfaceArtifactValue;
  readonly artifactId: string;
  // Absent only on legacy events; those resolve to the latest revision server-side.
  readonly revision?: number;
  readonly resolvedView?: ResolvedSurfaceViewNode;
  readonly codeView?: SurfaceCodeViewPayload;
  readonly actionHandles?: Readonly<Record<string, string>>;
  readonly onInteraction?: (
    handle: string,
    input: Readonly<Record<string, unknown>>
  ) => void | Promise<void>;
}

type SurfaceState = {
  key: string;
  artifact?: SurfaceArtifactValue;
  actionHandles: Readonly<Record<string, string>>;
  resolvedView?: ResolvedSurfaceViewNode;
  codeView?: SurfaceCodeViewPayload;
  status: "idle" | "loading" | "ready" | "error";
};

function surfaceKey(artifactId: string, revision: number | undefined): string {
  return `${artifactId}:${revision ?? "latest"}`;
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
  const key = surfaceKey(artifactId, revision);
  const [retry, setRetry] = useState(0);
  const initialState = useMemo<SurfaceState>(
    () => ({
      key,
      artifact: initialArtifact,
      actionHandles: initialActionHandles ?? {},
      resolvedView: initialResolvedView,
      codeView: initialCodeView,
      status: "idle",
    }),
    [key, initialArtifact, initialActionHandles, initialResolvedView, initialCodeView]
  );
  const [state, setState] = useState(initialState);
  const requestIdentity = `${key}:${retry}`;
  const latestRequest = useRef(requestIdentity);
  latestRequest.current = requestIdentity;

  useEffect(() => {
    const needsHandles =
      initialArtifact !== undefined &&
      surfaceActionsForArtifact(initialArtifact).some((action) => !action.disabled) &&
      initialActionHandles === undefined;
    const needsPresentation =
      initialArtifact?.component.name.startsWith("business.") === true &&
      initialResolvedView === undefined &&
      initialCodeView === undefined;
    if (initialArtifact !== undefined && !needsHandles && !needsPresentation) {
      setState({ ...initialState, status: "ready" });
      return;
    }

    const controller = new AbortController();
    setState({ ...initialState, status: "loading" });
    void apiGet<{
      artifact: SurfaceArtifactValue;
      actionHandles: Readonly<Record<string, string>>;
      resolvedView?: ResolvedSurfaceViewNode;
      codeView?: SurfaceCodeViewPayload;
    }>(
      `/api/v1/surfaces/${encodeURIComponent(artifactId)}${revision === undefined ? "" : `?revision=${revision}`}`,
      { signal: controller.signal }
    )
      .then((value) => {
        if (controller.signal.aborted || latestRequest.current !== requestIdentity) return;
        setState({
          key: initialState.key,
          artifact: value.artifact,
          actionHandles: value.actionHandles,
          resolvedView: value.resolvedView,
          codeView: value.codeView,
          status: "ready",
        });
      })
      .catch(() => {
        if (!controller.signal.aborted && latestRequest.current === requestIdentity) {
          setState({ ...initialState, status: "error" });
        }
      });
    return () => controller.abort();
  }, [
    artifactId,
    initialActionHandles,
    initialArtifact,
    initialCodeView,
    initialResolvedView,
    initialState,
    requestIdentity,
    revision,
  ]);

  const current = state.key === key ? state : { ...initialState, status: "loading" as const };
  const actionHandleFor = (action: Parameters<typeof surfaceActionKey>[0]) =>
    current.actionHandles[surfaceActionKey(action)];

  if (current.status === "error") {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-run-error">
          Presentation could not be loaded.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry presentation
        </Button>
      </div>
    );
  }
  if (current.artifact && current.codeView) {
    return (
      <SurfaceCodeView
        artifact={current.artifact}
        module={current.codeView.compiled}
        onInteraction={onInteraction}
        actionHandleFor={actionHandleFor}
      />
    );
  }
  if (current.artifact && current.resolvedView) {
    return (
      <SurfaceCompositionView
        artifact={current.artifact}
        view={current.resolvedView}
        onInteraction={onInteraction}
        actionHandleFor={actionHandleFor}
      />
    );
  }
  if (current.artifact && !current.artifact.component.name.startsWith("business.")) {
    return (
      <SurfaceView
        artifact={current.artifact}
        onInteraction={onInteraction}
        actionHandleFor={actionHandleFor}
      />
    );
  }
  if (current.artifact && current.status === "ready") {
    return <div role="alert">Published presentation component unavailable.</div>;
  }
  return <div role="status">Loading presentation…</div>;
}
