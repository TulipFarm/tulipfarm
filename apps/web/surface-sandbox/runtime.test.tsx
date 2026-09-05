/**
 * The frame runtime is the only place authored code actually executes, and it has one contract
 * beyond drawing: authored code may use React hooks (ADR-031). A regression here is invisible to
 * every other test — a hookless component still renders fine — so it is pinned separately.
 */

import { beforeAll, describe, expect, it } from "vitest";

const HOOK_MODULE = `
function render(props) {
  const [count, setCount] = React.useState(props.start);
  return React.createElement(
    "button",
    { id: "cell", onClick: () => setCount(count + 1) },
    String(count)
  );
}
`;

function renderInFrame(module: string, props: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      data: { v: 1, type: "tulip.render", module, props },
    })
  );
}

describe("surface sandbox runtime", () => {
  const errors: string[] = [];

  beforeAll(async () => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    window.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as { type?: string; message?: string };
      if (data?.type === "tulip.error") errors.push(String(data.message));
    });
    await import("./runtime");
  });

  it("runs authored code as a component, so React hooks work inside it", async () => {
    renderInFrame(HOOK_MODULE, { start: 7 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toEqual([]);
    expect(document.getElementById("cell")?.textContent).toBe("7");
    expect(document.getElementById("error")).toBeNull();
  });
});
