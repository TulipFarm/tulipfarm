import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { ResourcePanel } from "~/components/resource-panel";

test("uses a sole current crumb as the page heading", () => {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => <ResourcePanel crumbs={[{ label: "resources" }]}>Content</ResourcePanel>,
    },
  ]);

  render(<Stub />);

  const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(breadcrumb).getByRole("heading", { level: 1, name: "resources" })).toBeVisible();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
});

test("leaves multi-crumb detail headings to the route content", () => {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <ResourcePanel crumbs={[{ label: "resources", to: "/resources" }, { label: "tickets" }]}>
          <h1>Ticket details</h1>
        </ResourcePanel>
      ),
    },
  ]);

  render(<Stub />);

  expect(screen.getByRole("link", { name: "resources" })).toHaveAttribute("href", "/resources");
  expect(screen.getByText("tickets")).toBeVisible();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("heading", { level: 1, name: "Ticket details" })).toBeVisible();
});
