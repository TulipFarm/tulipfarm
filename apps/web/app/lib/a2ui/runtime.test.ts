import { afterEach, expect, test, vi } from "vitest";
import { A2UI_RUNTIME } from "~/lib/a2ui/runtime";

// Run the audited runtime STRING the way the iframe does. In jsdom `window.parent === window`, so a
// spy on `window.postMessage` captures every outbound frame; we filter for the `agent` channel.
function runRuntime(): { agentPosts: unknown[] } {
  const agentPosts: unknown[] = [];
  vi.spyOn(window, "postMessage").mockImplementation((msg: unknown) => {
    const frame = msg as { channel?: string; payload?: unknown } | null;
    if (frame && typeof frame === "object" && frame.channel === "agent") {
      agentPosts.push(frame.payload);
    }
  });
  new Function(A2UI_RUNTIME)();
  return { agentPosts };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

test("a click on a [data-a2ui-send] control posts its payload through the agent channel", () => {
  document.body.innerHTML =
    '<tf-card><tf-button data-a2ui-send=\'{"kind":"choice","value":"a","label":"A"}\'>A</tf-button></tf-card>';
  const { agentPosts } = runRuntime();
  document.querySelector("tf-button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(agentPosts).toContainEqual({ kind: "choice", value: "a", label: "A" });
});

test("a click on a child of the control still resolves the nearest data-a2ui-send", () => {
  document.body.innerHTML =
    '<tf-button data-a2ui-send=\'{"kind":"choice","value":"x"}\'><span id="inner">x</span></tf-button>';
  const { agentPosts } = runRuntime();
  document.getElementById("inner")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(agentPosts).toContainEqual({ kind: "choice", value: "x" });
});

test("malformed data-a2ui-send JSON is a no-op (no throw, no post)", () => {
  document.body.innerHTML = '<tf-button data-a2ui-send="{not json">bad</tf-button>';
  const { agentPosts } = runRuntime();
  expect(() =>
    document.querySelector("tf-button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  ).not.toThrow();
  expect(agentPosts).toHaveLength(0);
});
