import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import DesignGuideRoute, { clientLoader } from "./_app.design-guide";

// jsdom has no layout engine; the transcript's auto-scroll calls scrollIntoView.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// The transcript and the composer are code-split, so rendering the guide fetches and transforms
// both chunks from inside the test body. On a loaded CI runner that costs more than Testing
// Library's `asyncUtilTimeout`, which failed the assertion below while the test still had most of
// its own budget left. Pull the cost into a hook so the test measures the render, not the compiler.
beforeAll(async () => {
  await Promise.all([
    import("~/components/chat/transcript"),
    import("~/components/chat/composer-editor"),
  ]);
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

// The guide is a development-only internal reference: it ships demo-only specimens and an
// unreleased component vocabulary, so a built instance must not serve it. Staging and production
// 404 by design — see docs/qa/playbooks/design-system.md.
test("serves the guide only while running the dev server", () => {
  vi.stubEnv("DEV", true);

  expect(clientLoader()).toBeNull();
});

test("404s the guide on a built instance rather than exposing it", () => {
  vi.stubEnv("DEV", false);

  let thrown: unknown;
  try {
    clientLoader();
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).status).toBe(404);
});

test("showcases the live token, status, action, form, and composition vocabulary", async () => {
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
  // Both are code-split, so this still waits on a Suspense boundary even with the chunks warmed.
  // Measured at 11.5s on a cold cache with the whole suite running in parallel, which is why the
  // 5s `asyncUtilTimeout` the rest of the suite wants is not a budget this one assertion can meet.
  expect(await screen.findByText("claude-sonnet-5", {}, { timeout: 25_000 })).toBeInTheDocument();
  expect(screen.getByText("· Auto → Balanced effort")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Try harder with Thorough effort" })
  ).toBeInTheDocument();
  // Mounting the whole component vocabulary, both code-split Chat chunks included, makes this the
  // slowest test in the suite by an order of magnitude; it needs headroom over the 10s the rest of
  // the repo gets, and over the inner wait above so a real miss still names the element.
}, 60_000);
