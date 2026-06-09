import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
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
  { html, theme, onAgent, onApi, onNavigate, className },
  ref
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

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
        return;
      }
      if (msg.channel === "agent") onAgent?.(msg.payload);
      else if (msg.channel === "api") onApi?.(msg.payload);
      else if (msg.channel === "navigate") onNavigate?.(msg.payload);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onAgent, onApi, onNavigate]);

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
