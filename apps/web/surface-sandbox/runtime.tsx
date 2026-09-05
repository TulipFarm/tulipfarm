/**
 * The runtime that executes an agent-authored Surface code view inside the sandbox frame.
 *
 * Bundled with React by `scripts/build-surface-sandbox.mjs` and inlined into `frame.html`: the
 * document runs in an opaque origin, where every external script is refused by its own policy.
 *
 * The authored module is evaluated here, deliberately. That is not the security boundary — the
 * opaque origin and `connect-src 'none'` are — and nothing in this file should be read as one.
 */

import {
  SURFACE_SANDBOX_MAX_HEIGHT,
  SURFACE_SANDBOX_MIN_HEIGHT,
  type SurfaceSandboxOutboundMessage,
} from "@tulipfarm/surface/sandbox";
import React from "react";
import { createRoot, type Root } from "react-dom/client";

type AuthoredRender = (
  props: Readonly<Record<string, unknown>>,
  tulip: { emit: (action: unknown, input?: Record<string, unknown>) => void }
) => React.ReactNode;

function rootElement(): HTMLElement {
  const found = document.getElementById("root");
  if (!found) throw new Error("sandbox frame is missing its root element");
  return found;
}

const container = rootElement();
let root: Root | undefined;
let authored: AuthoredRender | undefined;

function post(message: SurfaceSandboxOutboundMessage): void {
  window.parent.postMessage(message, "*");
}

function fail(message: string): void {
  post({ v: 1, type: "tulip.error", message });
  container.innerHTML = "";
  const box = document.createElement("div");
  box.id = "error";
  box.textContent = "This view could not be displayed.";
  container.append(box);
}

const tulip = {
  emit(action: unknown, input: Record<string, unknown> = {}) {
    post({ v: 1, type: "tulip.emit", action, input });
  },
};

/**
 * Compile the authored module once and keep its `render`.
 *
 * `React` is passed in rather than left global so the module's own scope names it — esbuild
 * compiled the JSX to `React.createElement` calls at authoring time.
 */
function loadModule(source: string): AuthoredRender {
  const factory = new Function(
    "React",
    `${source}\n;return typeof render === "function" ? render : undefined;`
  ) as (react: typeof React) => AuthoredRender | undefined;
  const fn = factory(React);
  if (!fn) throw new Error("the module defines no render function");
  return fn;
}

/**
 * Renders the authored function as a component, not as a call.
 *
 * Calling `authored(props, tulip)` to build an element would run its body outside React's render
 * phase, so a `React.useState` inside it throws "Invalid hook call" — and local state is the whole
 * reason React is in this frame (ADR-031): an editable grid holds its edits here and emits once on
 * commit instead of one Turn per keystroke. The identity is fixed at module scope so a fresh
 * `tulip.render` re-renders the same component and keeps that state, rather than remounting it.
 */
function Authored({ props }: { props: Readonly<Record<string, unknown>> }): React.ReactNode {
  return authored ? authored(props, tulip) : null;
}

function draw(props: Readonly<Record<string, unknown>>): void {
  if (!authored) return;
  root ??= createRoot(container);
  root.render(React.createElement(ErrorBoundary, null, React.createElement(Authored, { props })));
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    post({ v: 1, type: "tulip.error", message: String(error) });
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

window.addEventListener("message", (event: MessageEvent) => {
  // The host is the only sender that can reach this document; `event.origin` is the string "null"
  // here and comparing it to anything is a bug waiting to be "fixed" with `allow-same-origin`.
  if (event.source !== window.parent) return;
  const data = event.data as { v?: number; type?: string; module?: string; props?: unknown };
  if (data?.v !== 1 || data.type !== "tulip.render") return;
  try {
    if (typeof data.module === "string" && !authored) authored = loadModule(data.module);
    draw((data.props ?? {}) as Record<string, unknown>);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
});

new ResizeObserver(() => {
  const px = Math.min(
    SURFACE_SANDBOX_MAX_HEIGHT,
    Math.max(SURFACE_SANDBOX_MIN_HEIGHT, Math.ceil(container.getBoundingClientRect().height))
  );
  post({ v: 1, type: "tulip.height", px });
}).observe(container);

post({ v: 1, type: "tulip.ready" });
