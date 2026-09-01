import { createRemixStub } from "@remix-run/testing";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  cleanup();
});

const admin = true;

vi.mock("~/lib/use-session-user", () => ({
  useSessionUser: () => ({
    id: "u1",
    email: "a@b.dev",
    name: null,
    role: admin ? "admin" : "member",
  }),
  useIsAdmin: () => admin,
}));

vi.mock("~/lib/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/integrations")>()),
  listIntegrations: vi.fn(),
  getIntegration: vi.fn(),
  inspectIntegrationSource: vi.fn(),
  installIntegration: vi.fn(),
  updateIntegration: vi.fn(),
}));

import type { IntegrationSummary } from "~/lib/integrations";
import {
  getIntegration,
  inspectIntegrationSource,
  installIntegration,
  updateIntegration,
} from "~/lib/integrations";
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

function renderCatalog(integrations: IntegrationSummary[], initialEntry = "/") {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => <IntegrationsIndex />,
      loader: () => ({ integrations }),
    },
    { path: "/integrations/:name", Component: () => <p>detail</p> },
  ]);
  render(<Stub initialEntries={[initialEntry]} />);
}

test("shows the registry's brand name rather than the slug", async () => {
  renderCatalog([integration({ name: "github", title: "GitHub", homepage: "https://github.com" })]);
  expect(await screen.findByText("GitHub")).toBeInTheDocument();
  expect(screen.queryByText("github")).not.toBeInTheDocument();
});

test("names the provider behind the brand, not the slug, when a homepage is curated", async () => {
  renderCatalog([integration({ title: "GitHub", homepage: "https://www.github.com" })]);
  expect(await screen.findByText("By github.com")).toBeInTheDocument();
});

test("lists a coming-soon entry without offering a way to connect it", async () => {
  renderCatalog([
    integration({ name: "github", title: "GitHub" }),
    integration({ name: "jira", title: "Jira", availability: "coming_soon" }),
  ]);

  const headings = await screen.findAllByRole("heading", { level: 2 });
  expect(headings.map((h) => h.textContent)).toEqual(["All integrations", "Coming soon"]);
  const soon = headings[1].closest("section") as HTMLElement;
  expect(within(soon).getByText("Jira")).toBeInTheDocument();
  // The group heading and the card footer both say it: the section names it, the card states it.
  expect(within(soon).getAllByText("Coming soon")).toHaveLength(2);
  // It may preview — a card that does nothing reads as broken — but it must never link at the
  // detail page, which is where a connection would be offered.
  const preview = within(soon).getByRole("link", { name: /view details for jira/i });
  expect(preview).toHaveAttribute("href", "/?view=jira");
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
  expect(headings.map((h) => h.textContent)).toEqual(["Connected", "Available"]);
  const connected = headings[0].closest("section") as HTMLElement;
  expect(within(connected).getByText("Slack")).toBeInTheDocument();
  // The group's size is a badge beside its title, so an operator can see how much is connected
  // without counting rows.
  expect(within(connected).getByText("1")).toBeInTheDocument();
});

test("titles the single group plainly when nothing is connected", async () => {
  renderCatalog([integration({ status: "disconnected" })]);
  const headings = await screen.findAllByRole("heading", { level: 2 });
  expect(headings[0].textContent).toContain("All integrations");
});

test("an installed integration opens its preview panel from its card action", async () => {
  renderCatalog([integration({ name: "github", title: "GitHub", description: "Repos." })]);
  const link = await screen.findByRole("link", { name: /view details for github/i });
  // `?view=` and not a click handler: the preview has an address, so Back closes it and the link
  // can be opened in a new tab or shared.
  expect(link).toHaveAttribute("href", "/?view=github");
  // One anchor per card, stretched over the tile — the description sits beside it, not inside it.
  expect(screen.getByText("Repos.")).toBeInTheDocument();
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
  await user.type(screen.getByLabelText("Repository"), "acme/repo");
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
  await user.type(screen.getByLabelText("Repository"), "acme/repo");
  await user.click(screen.getByRole("button", { name: /read repository/i }));

  expect(await screen.findByText(/runs a handler module in the host process/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Install$/ })).toBeDisabled();
});

test("shows update available badge and update button on catalog row", async () => {
  const user = userEvent.setup();
  vi.mocked(updateIntegration).mockResolvedValue({
    name: "linear",
    source: "acme/linear",
    ref: "main",
  });

  renderCatalog([
    integration({
      name: "linear",
      title: "Linear",
      installed: true,
      source: "acme/linear",
      updateAvailable: true,
    }),
  ]);

  expect(await screen.findByText(/update available/i)).toBeInTheDocument();
  const updateButton = screen.getByRole("button", { name: /update linear/i });
  expect(updateButton).toBeInTheDocument();

  await user.click(updateButton);
  expect(updateIntegration).toHaveBeenCalledWith("linear", "acme/linear");
});

test("opens the preview panel straight from a ?view= URL, so the link is shareable", async () => {
  vi.mocked(getIntegration).mockResolvedValue({
    ...integration({ name: "github", title: "GitHub", homepage: "https://github.com" }),
    grants: [{ label: "issues", access: "read and write", description: "Triage and comment." }],
    capabilities: ["Review pull requests"],
    manifest: {},
    auth: [{ index: 0, kind: "fields", title: "Add a token", satisfied: false, producesEnv: true }],
    connected: false,
  });

  renderCatalog([integration({ name: "github", title: "GitHub" })], "/?view=github");

  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByText("Integrations / GitHub")).toBeInTheDocument();
  // The panel previews; it never performs the write itself, so its action leaves for the page
  // that does.
  expect(within(sheet).getByRole("link", { name: /^set up/i })).toHaveAttribute(
    "href",
    "/integrations/github"
  );
  expect(within(sheet).getByText("Review pull requests")).toBeInTheDocument();
  expect(within(sheet).getByText("issues")).toBeInTheDocument();
  // The integration's own status, and separately the state of one setup step — a step is "to do",
  // never "not connected", or the two read as the same fact reported twice.
  expect(within(sheet).getByText("Not connected")).toBeInTheDocument();
  expect(within(sheet).getByText("To do")).toBeInTheDocument();
});

test("the panel colours connection state, so a card and its panel agree", async () => {
  vi.mocked(getIntegration).mockResolvedValue({
    ...integration({ name: "github", title: "GitHub", status: "connected" }),
    grants: [],
    manifest: {},
    auth: [],
    connected: true,
  });

  renderCatalog(
    [integration({ name: "github", title: "GitHub", status: "connected" })],
    "/?view=github"
  );

  const sheet = await screen.findByRole("dialog");
  // A green "Connected" on the card must not turn grey the moment the panel opens — same fact,
  // same tone, or the colour stops meaning anything.
  expect(within(sheet).getByText("Connected")).toHaveClass("text-status-success");
});

test("a coming-soon preview offers no way to connect", async () => {
  vi.mocked(getIntegration).mockResolvedValue({
    ...integration({ name: "jira", title: "Jira", availability: "coming_soon" }),
    grants: [],
    manifest: {},
    auth: [],
    connected: false,
  });

  renderCatalog(
    [integration({ name: "jira", title: "Jira", availability: "coming_soon" })],
    "/?view=jira"
  );

  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).queryByRole("link", { name: /set up|manage/i })).not.toBeInTheDocument();
  // Not even the header shortcut: the detail page is where a connection would be offered.
  expect(within(sheet).queryByRole("link", { name: /open the full/i })).not.toBeInTheDocument();
});

test("offers asking an agent for an integration the catalog does not carry", async () => {
  const user = userEvent.setup();
  renderCatalog([integration({ name: "github", title: "GitHub" })]);

  await user.click(await screen.findByRole("button", { name: /more integration actions/i }));
  // A chat draft, because chat is how an agent is asked to build anything here — not a request
  // form that files into a queue nobody owns.
  const request = screen.getByRole("menuitem", { name: /request an integration/i });
  expect(request.getAttribute("href")).toMatch(/^\/\?draft=/);
});
