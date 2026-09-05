import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { SectionShell } from "./section-shell";

function renderAt(pathname: string) {
  const Stub = createRemixStub([{ path: "*", Component: SectionShell }]);
  return render(<Stub initialEntries={[pathname]} />);
}

test.each([
  ["/business/soul", "Soul"],
  ["/business/guardrails", "Guardrails"],
  ["/business/profile", "Business profile"],
  ["/business/models", "Models"],
  ["/business/access", "People"],
  ["/teams", "Teams"],
  ["/business/activities", "Activity"],
  ["/settings/appearance", "Appearance"],
  ["/integrations", "Integrations"],
])("%s names itself with exactly one h1", (pathname, label) => {
  renderAt(pathname);
  const headings = screen.getAllByRole("heading", { level: 1 });
  expect(headings).toHaveLength(1);
  expect(headings[0].textContent).toBe(label);
});

test("leaves the h1 to a detail route that names itself", () => {
  renderAt("/integrations/slack");
  expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
});

test("still renders the section description on the section's own page", () => {
  renderAt("/business/soul");
  expect(
    screen.getByText("Browse the version-controlled repository your workspace is defined in.")
  ).toBeTruthy();
});
