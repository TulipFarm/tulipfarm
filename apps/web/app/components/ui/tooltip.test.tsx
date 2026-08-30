import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { Tooltip } from "./tooltip";

/*
 * jsdom reports every rect as zero, so a positioning test has to supply its own geometry: a 36px
 * rail icon hard against the left edge, and a label far wider than it.
 */
function stubGeometry(trigger: Partial<DOMRect>, label: { width: number; height: number }) {
  const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element
  ) {
    const rect =
      this.getAttribute("role") === "tooltip"
        ? { width: label.width, height: label.height, left: 0, top: 0 }
        : { left: 9.5, top: 200, width: 36, height: 36, ...trigger };
    return {
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => "",
    } as DOMRect;
  });
  return spy;
}

afterEach(() => vi.restoreAllMocks());

test("portals visible content outside an overflow boundary", async () => {
  const user = userEvent.setup();
  render(
    <div className="overflow-hidden">
      <Tooltip content="Mention Agent (@)">
        <button type="button">Mention</button>
      </Tooltip>
    </div>
  );

  await user.hover(screen.getByRole("button", { name: "Mention" }));
  expect(screen.getByRole("tooltip")).toHaveTextContent("Mention Agent (@)");
  expect(screen.getByRole("tooltip").parentElement).toBe(document.body);
});

/* A centred label on a 36px rail icon lands at x=-32.5 — "Knowledge" loses its K off the screen. */
test("keeps a wide label on screen when the trigger hugs the left edge", async () => {
  stubGeometry({}, { width: 120, height: 24 });
  const user = userEvent.setup();
  render(
    <Tooltip content="Knowledge">
      <button type="button">K</button>
    </Tooltip>
  );

  await user.hover(screen.getByRole("button", { name: "K" }));
  expect(Number.parseFloat(screen.getByRole("tooltip").style.left)).toBeGreaterThanOrEqual(0);
  expect(screen.getByRole("tooltip").style.left).toBe("8px");
});

test("sits beside the trigger for a vertical icon rail", async () => {
  stubGeometry({}, { width: 120, height: 24 });
  const user = userEvent.setup();
  render(
    <Tooltip content="Knowledge" placement="right">
      <button type="button">K</button>
    </Tooltip>
  );

  await user.hover(screen.getByRole("button", { name: "K" }));
  const tip = screen.getByRole("tooltip");
  expect(tip.style.left).toBe("53.5px");
  expect(tip.style.top).toBe("206px");
});

/* The top-bar toggle sits at y=8, so a label placed above it rendered off the top of the window. */
test("flips below the trigger when there is no room above", async () => {
  stubGeometry({ left: 400, top: 8, width: 32, height: 32 }, { width: 110, height: 24 });
  const user = userEvent.setup();
  render(
    <Tooltip content="Collapse sidebar">
      <button type="button">C</button>
    </Tooltip>
  );

  await user.hover(screen.getByRole("button", { name: "C" }));
  expect(screen.getByRole("tooltip").style.top).toBe("48px");
});
