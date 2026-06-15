import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { type A2uiMessage, parseMessage } from "~/lib/a2ui/protocol";
import { sanitizeAgentHtml } from "~/lib/a2ui/sanitize";
import { buildSrcdoc } from "~/lib/a2ui/srcdoc";
import tokensCss from "~/tokens.css?raw";

export interface A2uiFrameProps {
  /** Agent-emitted HTML (pre-sanitize). May use tf-* web components. */
  html: string;
  /** Defaults to the shell's current `<html data-theme>`. */
  theme?: "light" | "dark";
  /** Pure transport — the host decides what each channel is allowed to do. */
  onAgent?: (payload: unknown) => void;
  onApi?: (payload: unknown) => void;
  onNavigate?: (payload: unknown) => void;
  /** Compiled tf-* fragments (by node id) swapped into the live surface without rebuilding (P2). */
  fragments?: Array<{ nodeId: string; html: string }>;
  className?: string;
}

export interface A2uiFrameHandle {
  /** Host → frame. Re-dispatched inside as `CustomEvent("a2ui:message")`. */
  send: (msg: A2uiMessage) => void;
}

function currentTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/**
 * Renders untrusted, agent-emitted HTML inside a sandboxed iframe that cannot reach the parent DOM
 * (sandbox="allow-scripts" with NO allow-same-origin → opaque origin). The only channel across the
 * boundary is postMessage; this component validates the message source, parses the envelope, and
 * relays it to host callbacks. It never performs API calls or navigation itself (pure transport).
 */
export const A2uiFrame = forwardRef<A2uiFrameHandle, A2uiFrameProps>(function A2uiFrame(
  { html, theme, onAgent, onApi, onNavigate, fragments, className },
  ref
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const fragmentsRef = useRef(fragments);
  fragmentsRef.current = fragments;

  const srcDoc = useMemo(
    () =>
      buildSrcdoc({
        sanitizedHtml: sanitizeAgentHtml(html),
        tokensCss,
        theme: theme ?? currentTheme(),
        nonce: crypto.randomUUID(),
      }),
    [html, theme]
  );

  // Push fragments into the frame as a sanitised "swap" — the runtime replaces each [data-a2ui-id]
  // node in place. Sanitising here (parent-side) is required: the CSP'd frame can't run DOMPurify.
  const postSwap = useCallback((f: Array<{ nodeId: string; html: string }> | undefined) => {
    const win = iframeRef.current?.contentWindow;
    if (!f || f.length === 0 || !win) return;
    win.postMessage(
      {
        __a2ui: "swap",
        fragments: f.map((x) => ({ nodeId: x.nodeId, html: sanitizeAgentHtml(x.html) })),
      },
      "*"
    );
  }, []);

  // Fragments arriving on an already-ready frame swap in immediately (html unchanged → no rebuild).
  // While the frame is (re)loading after an html change, `readyRef` is false and the `ready` handler
  // below re-applies the current fragments once the new document is parsed.
  useEffect(() => {
    if (readyRef.current) postSwap(fragments);
  }, [fragments, postSwap]);

  useImperativeHandle(
    ref,
    () => ({
      send(msg) {
        iframeRef.current?.contentWindow?.postMessage(msg, "*");
      },
    }),
    []
  );

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const iframe = iframeRef.current;
      // Validate by window reference; the sandbox's opaque "null" origin is also checked as
      // defense-in-depth (spec §6.4). Only the frame legitimately posts to this listener.
      if (!iframe || event.source !== iframe.contentWindow || event.origin !== "null") return;
      const msg = parseMessage(event.data);
      if (!msg) return;
      if ("__a2ui" in msg) {
        if (msg.__a2ui === "resize") iframe.style.height = `${msg.height}px`;
        else if (msg.__a2ui === "ready") {
          readyRef.current = true;
          postSwap(fragmentsRef.current); // (re)apply current fragments once the document is parsed
        }
        return;
      }
      if (msg.channel === "agent") onAgent?.(msg.payload);
      else if (msg.channel === "api") onApi?.(msg.payload);
      else if (msg.channel === "navigate") onNavigate?.(msg.payload);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onAgent, onApi, onNavigate, postSwap]);

  return (
    <iframe
      ref={iframeRef}
      title="A2UI content"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className={className}
      style={{ display: "block", width: "100%", border: "0" }}
    />
  );
});
