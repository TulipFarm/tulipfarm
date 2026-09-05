/**
 * Host side of a code-backed Surface view: the sandboxed frame, and nothing else.
 *
 * The `sandbox` attribute here is the security boundary. It must never gain `allow-same-origin`,
 * which would hand agent-authored code the session cookie and the host DOM; the frame's own
 * `connect-src 'none'` is the other half. `scripts/no-same-origin-sandbox.test.ts` pins this.
 */

import {
  isSurfaceAction,
  SURFACE_SANDBOX_ATTRIBUTE,
  SURFACE_SANDBOX_FRAME_SRC,
  SURFACE_SANDBOX_MAX_HEIGHT,
  SURFACE_SANDBOX_MIN_HEIGHT,
  type SurfaceSandboxRenderMessage,
} from "@tulipfarm/surface/client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SurfaceWebProps } from "./primitives";

export interface SurfaceCodeViewProps extends SurfaceWebProps {
  /** The compiled module produced at authoring time. Never authored source. */
  readonly module: string;
}

/** How long to wait for the frame's `tulip.ready` before telling the reader it did not load. */
const READY_TIMEOUT_MS = 5_000;

export function SurfaceCodeView({
  artifact,
  module,
  onInteraction,
  actionHandleFor,
}: SurfaceCodeViewProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(SURFACE_SANDBOX_MIN_HEIGHT);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  const props = artifact.props as Readonly<Record<string, unknown>>;

  const send = useCallback(() => {
    const target = frame.current?.contentWindow;
    if (!target) return;
    const message: SurfaceSandboxRenderMessage = { v: 1, type: "tulip.render", module, props };
    // The frame has an opaque origin, so "*" is the only targetOrigin that can reach it. Nothing
    // secret travels this way: `props` were already published in the artifact.
    target.postMessage(message, "*");
  }, [module, props]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { v?: number; type?: string; px?: number; message?: string };
      if (data?.v !== 1) return;
      if (data.type === "tulip.ready") {
        setReady(true);
        send();
        return;
      }
      if (data.type === "tulip.height" && typeof data.px === "number") {
        setHeight(
          Math.min(SURFACE_SANDBOX_MAX_HEIGHT, Math.max(SURFACE_SANDBOX_MIN_HEIGHT, data.px))
        );
        return;
      }
      if (data.type === "tulip.error") {
        setFailed(true);
        return;
      }
      if (data.type !== "tulip.emit") return;
      const emitted = event.data as { action?: unknown; input?: unknown };
      if (!isSurfaceAction(emitted.action)) return;
      // An action the component never declared minted no handle, so it is not emitted at all —
      // authored code cannot invent authority it was not granted at publish time.
      const handle = actionHandleFor?.(emitted.action);
      if (!handle) return;
      const input = emitted.input;
      void onInteraction?.(
        handle,
        (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>
      );
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [actionHandleFor, onInteraction, send]);

  useEffect(() => {
    if (ready) send();
  }, [ready, send]);

  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setFailed(true), READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  if (failed) {
    return (
      <div data-surface-code-view-error role="alert">
        This view could not be displayed.
      </div>
    );
  }

  return (
    <iframe
      data-surface-code-view
      ref={frame}
      sandbox={SURFACE_SANDBOX_ATTRIBUTE}
      src={SURFACE_SANDBOX_FRAME_SRC}
      title={artifact.component.name}
      height={height}
      style={{ width: "100%", height, border: "0", display: "block" }}
    />
  );
}
