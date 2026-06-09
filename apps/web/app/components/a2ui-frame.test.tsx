import { render } from "@testing-library/react";
import { createRef } from "react";
import { expect, test, vi } from "vitest";
import { A2uiFrame, type A2uiFrameHandle } from "~/components/a2ui-frame";

function renderFrame(props: Partial<Parameters<typeof A2uiFrame>[0]> = {}) {
  const ref = createRef<A2uiFrameHandle>();
  const { container } = render(<A2uiFrame ref={ref} html="<tf-card>x</tf-card>" {...props} />);
  const iframe = container.querySelector("iframe");
  if (!iframe) throw new Error("iframe not rendered");
  const win = iframe.contentWindow;
  if (!win) throw new Error("iframe has no contentWindow");
  return { ref, iframe, win };
}

// A sandboxed (no same-origin) iframe posts to its parent with the opaque origin "null".
function postFromFrame(source: Window | null, data: unknown, origin = "null") {
  window.dispatchEvent(new MessageEvent("message", { data, source, origin }));
}

test("renders a sandboxed iframe with allow-scripts and never same-origin", () => {
  const { iframe } = renderFrame();
  expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
  expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
  expect(iframe.getAttribute("srcdoc")).toContain("<tf-card>x</tf-card>");
});

test("routes agent/api/navigate messages from the iframe to host callbacks", () => {
  const onAgent = vi.fn();
  const onApi = vi.fn();
  const onNavigate = vi.fn();
  const { win } = renderFrame({ onAgent, onApi, onNavigate });
  postFromFrame(win, { channel: "agent", payload: 1 });
  postFromFrame(win, { channel: "api", payload: 2 });
  postFromFrame(win, { channel: "navigate", payload: 3 });
  expect(onAgent).toHaveBeenCalledWith(1);
  expect(onApi).toHaveBeenCalledWith(2);
  expect(onNavigate).toHaveBeenCalledWith(3);
});

test("ignores messages whose source is not the iframe", () => {
  const onAgent = vi.fn();
  renderFrame({ onAgent });
  postFromFrame(window, { channel: "agent", payload: 1 });
  expect(onAgent).not.toHaveBeenCalled();
});

test("ignores messages whose origin is not the opaque sandbox origin", () => {
  const onAgent = vi.fn();
  const { win } = renderFrame({ onAgent });
  postFromFrame(win, { channel: "agent", payload: 1 }, "https://evil.example");
  expect(onAgent).not.toHaveBeenCalled();
});

test("ignores malformed messages", () => {
  const onAgent = vi.fn();
  const { win } = renderFrame({ onAgent });
  postFromFrame(win, { nope: true });
  expect(onAgent).not.toHaveBeenCalled();
});

test("applies the iframe height from a resize message", () => {
  const { iframe, win } = renderFrame();
  postFromFrame(win, { __a2ui: "resize", height: 321 });
  expect(iframe.style.height).toBe("321px");
});

test("ref.send posts a message into the iframe", () => {
  const { ref, win } = renderFrame();
  const spy = vi.spyOn(win, "postMessage");
  const handle = ref.current;
  if (!handle) throw new Error("no handle");
  handle.send({ channel: "api", payload: { ok: true } });
  expect(spy).toHaveBeenCalledWith({ channel: "api", payload: { ok: true } }, "*");
});
