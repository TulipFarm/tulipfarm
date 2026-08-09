import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

vi.mock("~/lib/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/integrations")>()),
  listIntegrations: vi.fn(),
  inspectIntegrationSource: vi.fn(),
  installIntegration: vi.fn(),
}));

import type { IntegrationSummary } from "~/lib/integrations";
import { inspectIntegrationSource, installIntegration } from "~/lib/integrations";
import IntegrationsIndex from "./_app.integrations._index";

function integration(over: Partial<IntegrationSummary> = {}): IntegrationSummary {
  return {
    name: "github",
    title: "GitHub",
    type: "none",
    installed: true,
    status: "disconnected",
    ...over,
  };
}

function renderCatalog(integrations: IntegrationSummary[]) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => <IntegrationsIndex />,
      loader: () => ({ integrations }),
    },
    { path: "/integrations/:name", Component: () => <p>detail</p> },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

test("shows the registry's brand name rather than the slug", async () => {
  renderCatalog([integration({ name: "github", title: "GitHub" })]);
  expect(await screen.findByText("GitHub")).toBeInTheDocument();
  expect(screen.queryByText("github")).not.toBeInTheDocument();
});

test("falls back to the slug when nothing has curated a title", async () => {
  renderCatalog([integration({ name: "acme-crm", title: undefined })]);
  expect(await screen.findByText("acme-crm")).toBeInTheDocument();
});

test("groups connected integrations ahead of the rest", async () => {
  renderCatalog([
    integration({ name: "github", title: "GitHub", status: "disconnected" }),
    integration({ name: "slack", title: "Slack", status: "connected" }),
  ]);

  const headings = await screen.findAllByRole("heading", { level: 2 });
  expect(headings.map((h) => h.textContent?.replace(/\s+/g, " ").trim())).toEqual([
    "Connected (1)",
    "Available (1)",
  ]);
  expect(within(headings[0].parentElement as HTMLElement).getByText("Slack")).toBeInTheDocument();
});

test("titles the single group plainly when nothing is connected", async () => {
  renderCatalog([integration({ status: "disconnected" })]);
  const headings = await screen.findAllByRole("heading", { level: 2 });
  expect(headings[0].textContent).toContain("All integrations");
});

test("an installed integration opens its detail page from anywhere in the row", async () => {
  renderCatalog([integration({ name: "github", title: "GitHub", description: "Repos." })]);
  const link = await screen.findByRole("link", { name: /GitHub/ });
  expect(link).toHaveAttribute("href", "/integrations/github");
  // The description is inside the link, not beside it: the whole row is the target.
  expect(within(link).getByText("Repos.")).toBeInTheDocument();
});

test("a curated entry that is not installed yet is not a link to a detail page", async () => {
  // Nothing has been cloned, so `/integrations/linear` would 404 — the row must not offer it.
  renderCatalog([
    integration({
      name: "linear",
      title: "Linear",
      installed: false,
      source: "acme/tulipfarm-linear",
    }),
  ]);
  expect(await screen.findByText("Not installed")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Linear/ })).not.toBeInTheDocument();
});

test("searches the slug as well as the brand name", async () => {
  const user = userEvent.setup();
  renderCatalog([
    integration({ name: "github", title: "GitHub" }),
    integration({ name: "slack", title: "Slack" }),
  ]);

  await user.type(await screen.findByLabelText(/search integrations/i), "githu");
  expect(screen.getByText("GitHub")).toBeInTheDocument();
  expect(screen.queryByText("Slack")).not.toBeInTheDocument();
});

test("filters by category and clears back to everything", async () => {
  const user = userEvent.setup();
  renderCatalog([
    integration({ name: "github", title: "GitHub", category: "code" }),
    integration({ name: "slack", title: "Slack", category: "chat" }),
  ]);

  await user.click(await screen.findByRole("button", { name: "chat" }));
  expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  expect(screen.getByText("Slack")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "chat" }));
  expect(screen.getByText("GitHub")).toBeInTheDocument();
});

test("says nothing matched rather than looking empty", async () => {
  const user = userEvent.setup();
  renderCatalog([integration({ name: "github", title: "GitHub" })]);

  await user.type(await screen.findByLabelText(/search integrations/i), "zzzz");
  expect(screen.getByText(/nothing matches that search/i)).toBeInTheDocument();
});

test("inspects a repository before anything is written, then installs the chosen integration", async () => {
  const user = userEvent.setup();
  vi.mocked(inspectIntegrationSource).mockResolvedValue({
    source: "acme/repo",
    ref: "main",
    integrations: [
      {
        name: "linear",
        description: "Track issues.",
        installed: false,
        installable: true,
        issues: [],
      },
    ],
  });
  vi.mocked(installIntegration).mockResolvedValue({
    name: "linear",
    source: "acme/repo",
    ref: "main",
  });

  renderCatalog([integration()]);

  await user.click(await screen.findByRole("button", { name: /install from git/i }));
  await user.type(screen.getByLabelText(/repository/i), "acme/repo");
  await user.click(screen.getByRole("button", { name: /read repository/i }));

  expect(await screen.findByText("Track issues.")).toBeInTheDocument();
  // Reading a repo must not install from it — that is the whole point of the two steps.
  expect(installIntegration).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: /^Install$/ }));
  expect(installIntegration).toHaveBeenCalledWith("acme/repo", "linear");
});

test("names why a repo's integration was refused instead of just disabling it", async () => {
  const user = userEvent.setup();
  vi.mocked(inspectIntegrationSource).mockResolvedValue({
    source: "acme/repo",
    ref: "main",
    integrations: [
      {
        name: "sneaky",
        installed: false,
        installable: false,
        issues: ['egress.type "ts-code" runs a handler module in the host process'],
      },
    ],
  });

  renderCatalog([integration()]);

  await user.click(await screen.findByRole("button", { name: /install from git/i }));
  await user.type(screen.getByLabelText(/repository/i), "acme/repo");
  await user.click(screen.getByRole("button", { name: /read repository/i }));

  expect(await screen.findByText(/runs a handler module in the host process/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Install$/ })).toBeDisabled();
});
