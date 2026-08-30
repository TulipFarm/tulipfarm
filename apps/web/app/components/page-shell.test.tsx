import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { PageShell } from "./page-shell";

function renderShell(node: React.ReactElement) {
  const Stub = createRemixStub([{ path: "/", Component: () => node }]);
  render(<Stub initialEntries={["/"]} />);
}

test("names the page once, as an h1", () => {
  renderShell(<PageShell title="Agents">body</PageShell>);
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Agents");
});

// The last crumb is the title, so rendering both would name the page twice in two type sizes.
test("drops the last crumb and links the rest", () => {
  renderShell(
    <PageShell
      crumbs={[{ label: "Resources", to: "/resources" }, { label: "ticket" }]}
      title="ticket"
    >
      body
    </PageShell>
  );
  expect(screen.getByRole("link", { name: "Resources" })).toHaveAttribute("href", "/resources");
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).not.toHaveTextContent("ticket");
});

test("renders no breadcrumb when the trail would be empty", () => {
  renderShell(
    <PageShell crumbs={[{ label: "Agents" }]} title="Agents">
      body
    </PageShell>
  );
  expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
});

test("carries description, meta and actions beside the title", () => {
  renderShell(
    <PageShell
      title="GitHub Issue Triage"
      description="Classifies issues."
      meta={<span>engineering</span>}
      actions={<button type="button">Start a chat</button>}
    >
      body
    </PageShell>
  );
  expect(screen.getByText("Classifies issues.")).toBeInTheDocument();
  expect(screen.getByText("engineering")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start a chat" })).toBeInTheDocument();
});

// Per-page widths made the title jump horizontally on every navigation. There is now one column.
test("every page lands on the same content column", () => {
  renderShell(<PageShell title="Page">body</PageShell>);
  const column = document.querySelector(".max-w-7xl");
  expect(column).not.toBeNull();
  expect(column).toHaveClass("mx-auto");
  expect(document.querySelector(".max-w-4xl")).toBeNull();
  expect(document.querySelector(".max-w-xl")).toBeNull();
});
