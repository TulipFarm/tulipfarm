import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Panel, PanelEmpty, PanelRow } from "./panel";

test("names the group it wraps without claiming page identity", () => {
  // The top bar owns the page name, so a Panel heading is an h2 and never an h1.
  render(<Panel title="Fallback chain">chain</Panel>);

  const heading = screen.getByRole("heading", { name: "Fallback chain" });
  expect(heading.tagName).toBe("H2");
});

test("renders description and actions alongside the title", () => {
  render(
    <Panel
      title="Secrets"
      description="Values are never shown again."
      actions={<button type="button">Add</button>}
    >
      body
    </Panel>
  );

  expect(screen.getByText("Values are never shown again.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
});

test("omits the header region entirely when unlabelled", () => {
  render(<Panel>bare</Panel>);

  expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  expect(screen.getByText("bare")).toBeInTheDocument();
});

test("composes full-bleed rows and an empty state", () => {
  const { rerender } = render(
    <Panel title="People" flush>
      <PanelRow>Priya Raghunathan</PanelRow>
    </Panel>
  );
  expect(screen.getByText("Priya Raghunathan")).toBeInTheDocument();

  rerender(
    <Panel title="People" flush>
      <PanelEmpty>No one has been invited yet.</PanelEmpty>
    </Panel>
  );
  expect(screen.getByText("No one has been invited yet.")).toBeInTheDocument();
});
