import { createRemixStub } from "@remix-run/testing";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

afterEach(() => {
  cleanup();
});

let admin = true;

beforeEach(() => {
  admin = true;
  vi.clearAllMocks();
});

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
  updateIntegration: vi.fn(),
}));

import type { IntegrationSummary } from "~/lib/integrations";
import { getIntegration, updateIntegration } from "~/lib/integrations";
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

test("keeps provider metadata out of the minimal catalog row", async () => {
  renderCatalog([integration({ title: "GitHub", homepage: "https://www.github.com" })]);
  expect(await screen.findByText("GitHub")).toBeInTheDocument();
  expect(screen.queryByText("By github.com")).not.toBeInTheDocument();
});

test("lists a coming-soon entry without offering a way to connect it", async () => {
  renderCatalog([
    integration({ name: "github", title: "GitHub" }),
    integration({ name: "jira", title: "Jira", availability: "coming_soon" }),
  ]);

  const headings = await screen.findAllByRole("heading", { level: 2 });
  expect(headings.map((h) => h.textContent)).toEqual(["Available", "Coming soon"]);
  expect(screen.getByText("Jira")).toBeInTheDocument();
  expect(screen.getAllByText("Coming soon")).toHaveLength(2);
  expect(screen.queryByRole("link", { name: /view details for jira/i })).not.toBeInTheDocument();
});

test("falls back to the slug when nothing has curated a title", async () => {
  renderCatalog([integration({ name: "acme-crm", title: undefined })]);
  expect(await screen.findByText("acme-crm")).toBeInTheDocument();
});

test("filters the catalog to connected integrations", async () => {
  const user = userEvent.setup();
  renderCatalog([
    integration({ name: "github", title: "GitHub", status: "disconnected" }),
    integration({ name: "slack", title: "Slack", status: "connected" }),
  ]);

  await user.click(await screen.findByRole("button", { name: "Connected" }));
  expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  expect(screen.getByText("Slack")).toBeInTheDocument();
});

test("keeps the blue capability banner and labels its activity as examples", async () => {
  renderCatalog([
    integration({ name: "jira", title: "Jira", availability: "coming_soon" }),
    integration({ name: "github", title: "GitHub", status: "connected" }),
    integration({ name: "slack", title: "Slack", status: "disconnected" }),
  ]);

  await screen.findByText("GitHub");
  const banner = screen.getByRole("region", { name: "Integration capability examples" });
  expect(within(banner).getByText("Example activity")).toBeInTheDocument();
  for (const example of [
    "Reviewed 14 pull requests before merge",
    "Updated 23 tasks after the last run",
    "Sent 8 updates to team channels",
  ]) {
    expect(within(banner).getByText(example)).toBeInTheDocument();
  }
  expect(
    screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)
  ).toEqual(["Connected", "Available", "Coming soon"]);
  expect(
    within(screen.getByRole("region", { name: "Connected" })).getByText("GitHub")
  ).toBeInTheDocument();
});

test("groups a disconnected provider as available even without a category", async () => {
  renderCatalog([integration({ status: "disconnected" })]);
  const headings = await screen.findAllByRole("heading", { level: 2 });
  expect(headings[0].textContent).toBe("Available");
});

test("an installed integration opens its preview panel from its card action", async () => {
  renderCatalog([integration({ name: "github", title: "GitHub", description: "Repos." })]);
  const link = await screen.findByRole("link", { name: /view details for github/i });
  // `?view=` and not a click handler: the preview has an address, so Back closes it and the link
  // can be opened in a new tab or shared.
  expect(link).toHaveAttribute("href", "/?view=github");
  expect(screen.getByText("Repos.")).toBeInTheDocument();
  expect(
    screen.queryByText("Browse repositories and review pull requests")
  ).not.toBeInTheDocument();
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

  await user.click(screen.getByRole("button", { name: "All" }));
  expect(screen.getByText("GitHub")).toBeInTheDocument();
});

test("says nothing matched rather than looking empty", async () => {
  const user = userEvent.setup();
  renderCatalog([integration({ name: "github", title: "GitHub" })]);

  await user.type(await screen.findByLabelText(/search integrations/i), "zzzz");
  expect(screen.getByText(/nothing matches that search/i)).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("0 integrations match");
  await user.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByText("GitHub")).toBeInTheDocument();
});

test("offers an update without hiding the integration's real connection state", async () => {
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

  const updateButton = await screen.findByRole("button", { name: /update linear/i });
  expect(updateButton).toBeInTheDocument();
  expect(screen.getByText("Update available")).toBeInTheDocument();
  expect(screen.getByText("Not connected")).toBeInTheDocument();

  await user.click(updateButton);
  expect(updateIntegration).toHaveBeenCalledWith("linear", "acme/linear");
});

test("keeps connection states distinct instead of replacing errors with a connect action", async () => {
  renderCatalog([
    integration({ name: "github", title: "GitHub", status: "error" }),
    integration({ name: "slack", title: "Slack", status: "connecting" }),
  ]);
  expect(await screen.findByText("Error")).toBeInTheDocument();
  expect(screen.getByText("Connecting")).toBeInTheDocument();
  expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /view details for github/i })).toHaveTextContent(
    "View details"
  );
});

test("connected and category filters work together and expose their selected state", async () => {
  const user = userEvent.setup();
  renderCatalog([
    integration({ name: "github", title: "GitHub", category: "code", status: "connected" }),
    integration({ name: "slack", title: "Slack", category: "chat", status: "connected" }),
    integration({ name: "chat-api", title: "Chat API", category: "chat" }),
  ]);
  await user.click(await screen.findByRole("button", { name: "Connected" }));
  await user.click(screen.getByRole("button", { name: "chat" }));
  expect(screen.getByRole("button", { name: "Connected" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "chat" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("Slack")).toBeInTheDocument();
  expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  expect(screen.queryByText("Chat API")).not.toBeInTheDocument();
});

test("an empty connected filter offers the available providers", async () => {
  const user = userEvent.setup();
  renderCatalog([integration()]);
  await user.click(await screen.findByRole("button", { name: "Connected" }));
  expect(screen.getByRole("heading", { name: "No connected integrations" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Browse available" }));
  expect(screen.getByText("GitHub")).toBeInTheDocument();
});

test("an empty catalog offers chat rather than a nonexistent install form", async () => {
  renderCatalog([]);
  expect(
    await screen.findByRole("heading", { name: "No integrations available" })
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Ask in chat" }).getAttribute("href")).toMatch(
    /^\/\?draft=/
  );
  expect(screen.queryByText(/install one from a git repository/i)).not.toBeInTheDocument();
});

test("a non-admin cannot update a provider from its catalog card", async () => {
  admin = false;
  renderCatalog([integration({ updateAvailable: true })]);
  await screen.findByText("GitHub");
  expect(screen.queryByRole("button", { name: /update github/i })).not.toBeInTheDocument();
  expect(updateIntegration).not.toHaveBeenCalled();
});

test("an update failure is announced and preserves the catalog", async () => {
  const user = userEvent.setup();
  vi.mocked(updateIntegration).mockRejectedValue(new Error("Update refused"));
  renderCatalog([integration({ updateAvailable: true })]);
  await user.click(await screen.findByRole("button", { name: /update github/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Update refused");
  expect(screen.getByText("GitHub")).toBeInTheDocument();
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
  // The sheet opens on the URL param alone, so its title is the slug until `getIntegration`
  // resolves. Await the resolved name rather than reading the placeholder.
  expect(await within(sheet).findByText("Integrations / GitHub")).toBeInTheDocument();
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
  expect(await within(sheet).findByText("Connected")).toHaveClass("text-status-success");
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
  // The panel cannot know an integration is coming soon until its detail lands, so it renders the
  // header shortcut while loading. Wait for the loaded body before asserting on what it withholds,
  // or this passes only on a machine fast enough to settle the fetch within the same tick.
  await within(sheet).findByText("Coming soon");
  expect(within(sheet).queryByRole("link", { name: /set up|manage/i })).not.toBeInTheDocument();
  // Not even the header shortcut: the detail page is where a connection would be offered.
  expect(within(sheet).queryByRole("link", { name: /open the full/i })).not.toBeInTheDocument();
});
