import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { expect, test } from "vitest";
import {
  PageChromeProvider,
  usePageChromeTitle,
  useSetActionSlot,
} from "~/lib/page-chrome-context";
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

test("the page workspace uses the available width", () => {
  renderShell(<PageShell title="Page">body</PageShell>);
  const column = document.querySelector(".w-full");
  expect(column).not.toBeNull();
  expect(column).not.toHaveClass("mx-auto");
  expect(column).not.toHaveClass("max-w-7xl");
  expect(document.querySelector(".max-w-4xl")).toBeNull();
  expect(document.querySelector(".max-w-xl")).toBeNull();
});

test("lets focused pages cap their own workspace without changing the shared shell", () => {
  renderShell(
    <PageShell title="Profile" contentClassName="mx-auto max-w-3xl">
      body
    </PageShell>
  );

  expect(document.querySelector(".max-w-3xl")).toHaveClass("w-full", "mx-auto");
});

// The bar names the page, so a second visible copy in the content would name it twice. The
// heading has to survive that as an h1 regardless, because a screen reader's heading list is the
// only way some readers find out where they are.
test("keeps the h1 for assistive technology while the bar carries the visible name", () => {
  renderShell(<PageShell title="Agents">body</PageShell>);
  const heading = screen.getByRole("heading", { level: 1 });
  expect(heading).toHaveTextContent("Agents");
  expect(heading).toHaveClass("sr-only");
});

// Actions used to vanish outright when no header slot existed, because the portal target was
// treated as guaranteed. A page's actions must degrade to somewhere visible instead.
test("renders actions in place when no header slot has been provided", () => {
  renderShell(
    <PageShell title="Skills" actions={<button type="button">Browse marketplace</button>}>
      body
    </PageShell>
  );
  expect(screen.getByRole("button", { name: "Browse marketplace" })).toBeInTheDocument();
});

test("moves actions into the header slot when there is one", () => {
  const slot = document.createElement("div");
  slot.id = "header-slot";
  document.body.append(slot);

  function Harness() {
    const setSlot = useSetActionSlot();
    useEffect(() => setSlot(slot), [setSlot]);
    return (
      <PageShell title="Skills" actions={<button type="button">Browse marketplace</button>}>
        body
      </PageShell>
    );
  }

  renderShell(
    <PageChromeProvider>
      <Harness />
    </PageChromeProvider>
  );

  const action = screen.getByRole("button", { name: "Browse marketplace" });
  expect(slot).toContainElement(action);
  slot.remove();
});

test("publishes its title so the header can name a detail page after its record", () => {
  function Harness() {
    const title = usePageChromeTitle();
    return (
      <>
        <span data-testid="published">{title ?? "none"}</span>
        <PageShell title="agent-forge">body</PageShell>
      </>
    );
  }

  renderShell(
    <PageChromeProvider>
      <Harness />
    </PageChromeProvider>
  );

  expect(screen.getByTestId("published")).toHaveTextContent("agent-forge");
});
