import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { beforeAll, expect, test, vi } from "vitest";
import DesignGuideRoute from "./_app.design-guide";

// jsdom has no layout engine; the transcript's auto-scroll calls scrollIntoView.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

test("showcases the live token, status, action, form, and composition vocabulary", () => {
  const Stub = createRemixStub([{ path: "/design-guide", Component: DesignGuideRoute }]);
  render(<Stub initialEntries={["/design-guide"]} />);
  expect(screen.getByRole("heading", { name: "TulipFarm design guide" })).toBeInTheDocument();
  for (const heading of [
    "Design principles",
    "Tech stack",
    "Design tokens",
    "Typography scale",
    "Status & priority systems",
    "Loading state",
    "Trace",
    "Tool chips",
    "Component hierarchy",
    "Composition patterns",
    "Interactive patterns",
    "Layout system",
    "The /design-guide page",
    "Component index",
    "File conventions",
    "Common mistakes to avoid",
  ]) {
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
  }
  expect(screen.getByLabelText("Name")).toBeInTheDocument();
  // The shared composites every settings surface is built from must be showable, not just documented.
  expect(screen.getByRole("heading", { name: "Panel" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Rows and empties" })).toBeInTheDocument();
  expect(screen.getByText("No credentials are stored for this workspace.")).toBeInTheDocument();
  expect(screen.getByText("Enter a full URL, including https://.")).toBeInTheDocument();
  expect(screen.getAllByRole("alert").map((n) => n.textContent)).toContain(
    "Could not reach the API."
  );
  // Several status regions now share the page (the loader is one), so pick the one under test.
  expect(
    screen.getAllByRole("status").some((el) => el.textContent?.includes("Profile updated."))
  ).toBe(true);
  expect(screen.getByText("critical")).toBeInTheDocument();
  // The Chat model vocabulary: effort is chosen, a Model ID is only reported, and Auto names the
  // rung it resolved to. Rendered from the real Transcript/Composer, so it cannot drift from prod.
  expect(screen.getByText("claude-sonnet-5")).toBeInTheDocument();
  expect(screen.getByText("· Auto → Balanced effort")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Try harder with Thorough effort" })
  ).toBeInTheDocument();
}, 10_000);
