import { useLocation } from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GITHUB_KNOWLEDGE_PRESET, type McpIntegrationDefinition } from "@tulipfarm/schema";
import { beforeEach, expect, test, vi } from "vitest";
import type { McpConnectionData } from "~/components/integrations/mcp-connection-state";
import {
  configureMcpIntegration,
  getMcpCatalogSetup,
  type McpCatalogEntry,
} from "~/lib/mcp-integrations";
import IntegrationsIndex from "./_app.integrations._index";

let admin = true;
vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: () => admin }));
vi.mock("~/lib/mcp-integrations", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-integrations")>()),
  configureMcpIntegration: vi.fn(),
  getMcpCatalogSetup: vi.fn(),
}));
vi.mock("~/components/integrations/mcp-integration-panel", () => ({
  McpIntegrationPanel: ({ serverId }: { serverId: string }) => (
    <p>Integration management: {serverId}</p>
  ),
}));
beforeEach(() => {
  admin = true;
  vi.clearAllMocks();
  vi.mocked(getMcpCatalogSetup).mockResolvedValue({
    server: { ...configuredGitHub.server, authentication: { type: "token", sharedAllowed: false } },
    configuration: {
      authentication: "token",
      requiredSlots: ["accessToken"],
      sharedAllowed: false,
    },
    requiresOAuthApp: false,
  });
});

const server: McpIntegrationDefinition = {
  server: {
    id: "support",
    label: "Support",
    transport: { type: "streamable-http", url: "https://mcp.example.com/" },
  },
  enabled: false,
  reviewed: { tools: [], resources: [], prompts: [] },
};
const github: McpCatalogEntry = {
  id: "github",
  name: "GitHub",
  publisher: "GitHub",
  url: "https://api.githubcopilot.com/mcp/",
  publisherEvidence: "https://github.com/github/github-mcp-server",
  authentication: ["token", "oauth"],
  setup: [],
  limitations: [],
  knowledgeSync: "requires-reviewed-adapter",
  localPreset: GITHUB_KNOWLEDGE_PRESET,
};
const configuredGitHub: McpIntegrationDefinition = {
  ...server,
  server: {
    id: "github-mcp",
    label: "Work GitHub",
    transport: { type: "streamable-http", url: github.url },
  },
  enabled: true,
};

function mount(
  servers = [server],
  entries: McpCatalogEntry[] = [],
  overrides: Record<string, McpConnectionData> = {},
  channelConnected?: boolean
) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <>
          <IntegrationsIndex />
          <output aria-label="Current route">{useLocation().pathname}</output>
        </>
      ),
      loader: () => ({
        servers,
        connections: {
          ...Object.fromEntries(
            servers.map(({ server }) => [
              server.id,
              {
                accounts: [
                  {
                    id: "personal",
                    owner: { scope: "personal", principalId: "user" },
                    status: "active",
                    definitionDigest: "current",
                    expiresAt: null,
                  },
                ],
                configuration: { authentication: "token", definitionDigest: "current" },
                error: null,
              },
            ])
          ),
          ...overrides,
        },
        catalog: { entries, error: null },
        channels:
          channelConnected === undefined
            ? [{ name: "slack", error: "Channel status unavailable.", integration: null }]
            : [
                {
                  name: "slack",
                  error: null,
                  integration: {
                    name: "slack",
                    connected: channelConnected,
                    type: "native",
                    status: channelConnected ? "connected" : "disconnected",
                    installed: true,
                    grants: [],
                    manifest: {},
                    auth: [],
                  },
                },
              ],
      }),
    },
    { path: "/integrations/:name", Component: () => <p>Full integration page</p> },
  ]);
  render(<Stub />);
}

const unconnected: McpConnectionData = {
  accounts: [],
  configuration: {
    authentication: "token",
    requiredSlots: ["accessToken"],
    sharedAllowed: false,
    definitionDigest: "current",
  },
  error: null,
};

test("an enabled but unconnected provider resumes its exact definition with Connect", async () => {
  mount([configuredGitHub], [github], { "github-mcp": unconnected });
  await userEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
  const sheet = screen.getByRole("dialog", { name: "Connect Work GitHub" });
  expect(within(sheet).getByText("Integration management: github-mcp")).toBeVisible();
  expect(configureMcpIntegration).not.toHaveBeenCalled();
  expect(getMcpCatalogSetup).not.toHaveBeenCalled();
});

test("a disabled provider with a personal account remains Manage", async () => {
  mount([{ ...configuredGitHub, enabled: false }], [github]);
  expect(await screen.findByRole("button", { name: "Manage GitHub" })).toBeVisible();
  const filters = screen.getByRole("navigation", { name: "Integration filters" });
  await userEvent.click(within(filters).getByRole("button", { name: "enabled" }));
  expect(screen.queryByRole("button", { name: "Manage GitHub" })).not.toBeInTheDocument();
});

test("custom definitions use account state too and resume instead of creating again", async () => {
  mount([server], [], { support: unconnected });
  await userEvent.click(await screen.findByRole("button", { name: "Connect Support" }));
  expect(screen.getByRole("dialog", { name: "Connect Support" })).toBeVisible();
  expect(screen.getByText("Integration management: support")).toBeVisible();
  expect(configureMcpIntegration).not.toHaveBeenCalled();
});

test("account load failures render Retry, never a false Connect or Manage", async () => {
  mount([configuredGitHub, server], [github], {
    "github-mcp": { ...unconnected, error: "GitHub accounts unavailable" },
    support: { ...unconnected, error: "Support accounts unavailable" },
  });
  expect(await screen.findByRole("button", { name: "Retry GitHub" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry Support" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Connect GitHub" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Manage Support" })).not.toBeInTheDocument();
});

test.each([false, true])(
  "native channel action uses connected=%s, not response existence",
  async (connected) => {
    mount([], [], {}, connected);
    expect(
      await screen.findByRole("link", { name: `${connected ? "Manage" : "Connect"} Slack channel` })
    ).toHaveAttribute("href", "/integrations/slack?channel=1");
  }
);

async function openGitHubKnowledge() {
  await userEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
  await userEvent.click(screen.getByText("Optional Knowledge sync"));
  await userEvent.click(screen.getByRole("button", { name: "Set up GitHub Knowledge (local)" }));
}

test("retains the labelled example banner without claiming configured integrations are connected", async () => {
  mount();
  const banner = await screen.findByRole("region", { name: "Integration capability examples" });
  expect(within(banner).getByText("Example activity")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Manage Support" })).toHaveTextContent(/^Manage$/);
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
});

test("puts the banner first and integration setup before the separate channels", async () => {
  mount([], [github]);
  const banner = await screen.findByRole("region", { name: "Integration capability examples" });
  const catalog = screen.getByRole("region", { name: "Integrations" });
  const channels = screen.getByRole("region", { name: "Messages and events" });
  expect(banner.compareDocumentPosition(catalog) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(catalog.compareDocumentPosition(channels) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(screen.getByText("No integrations configured yet.")).toBeVisible();
  expect(screen.queryByText("No MCP servers configured")).not.toBeInTheDocument();
});

test("shows configured providers once and opens Manage in the sheet without navigating", async () => {
  mount([configuredGitHub], [github]);
  expect(await screen.findAllByRole("heading", { name: "GitHub" })).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Manage GitHub" }));
  const sheet = screen.getByRole("dialog", { name: "Manage Work GitHub" });
  expect(sheet).toHaveClass("tf-sheet");
  expect(within(sheet).getByText("Integration management: github-mcp")).toBeVisible();
  expect(within(sheet).getByRole("link", { name: "Open integration page" })).toHaveAttribute(
    "href",
    "/integrations/github-mcp"
  );
  expect(screen.getByLabelText("Current route")).toHaveTextContent(/^\/$/);
});

test("Connect leads with credentials and keeps setup help optional without writes", async () => {
  mount([], [github]);
  expect(await screen.findByRole("button", { name: "Connect GitHub" })).toHaveTextContent(
    /^Connect$/
  );
  expect(screen.queryByText("Before you connect")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Set up GitHub Knowledge (local)" })
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
  const sheet = screen.getByRole("dialog", { name: "Connect GitHub" });
  expect(sheet).toHaveClass("tf-sheet");
  expect(await within(sheet).findByLabelText("Access token")).toBeVisible();
  expect(within(sheet).getByText("Before you connect")).not.toBeVisible();
  await userEvent.click(within(sheet).getByText("Setup help · GitHub"));
  expect(within(sheet).getByRole("region", { name: "GitHub capabilities" })).toBeVisible();
  expect(within(sheet).getByRole("region", { name: "GitHub setup instructions" })).toBeVisible();
  expect(within(sheet).getByRole("link", { name: "Create a GitHub token" })).toHaveAttribute(
    "href",
    "https://github.com/settings/personal-access-tokens/new"
  );
  expect(await within(sheet).findByLabelText("Access token")).toBeVisible();
  expect(within(sheet).queryByLabelText("Name")).not.toBeInTheDocument();
  expect(within(sheet).queryByLabelText("Integration URL")).not.toBeInTheDocument();
  expect(configureMcpIntegration).not.toHaveBeenCalled();
});

test("searches catalog entries and configured labels, and clears unmatched searches", async () => {
  mount([configuredGitHub], [github]);
  const search = await screen.findByLabelText("Search integrations");
  await userEvent.type(search, "Work GitHub");
  expect(screen.getByRole("button", { name: "Manage GitHub" })).toBeVisible();
  await userEvent.clear(search);
  await userEvent.type(search, "unmatched");
  expect(screen.getByText("No integrations match this search.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Manage GitHub" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByRole("button", { name: "Manage GitHub" })).toBeVisible();
});

test("enabled and disabled filters apply consistently to configured providers and custom integrations", async () => {
  mount([server, configuredGitHub], [github]);
  const filters = await screen.findByRole("navigation", { name: "Integration filters" });
  await userEvent.click(within(filters).getByRole("button", { name: "enabled" }));
  expect(screen.queryByRole("button", { name: "Manage Support" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Manage GitHub" })).toBeVisible();
  await userEvent.click(within(filters).getByRole("button", { name: "disabled" }));
  expect(screen.getByRole("button", { name: "Manage Support" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Manage GitHub" })).not.toBeInTheDocument();
});

test("does not hide additional definitions for the same provider", async () => {
  const additional = {
    ...configuredGitHub,
    server: { ...configuredGitHub.server, id: "other-github", label: "Other GitHub" },
  };
  mount([configuredGitHub, additional], [github]);
  expect(await screen.findByRole("button", { name: "Manage GitHub" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Manage Other GitHub" })).toBeVisible();
});

test("native channel failures remain visible beside working integration management", async () => {
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Channel status unavailable.");
  expect(screen.getByRole("button", { name: "Manage Support" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry channel status" })).toBeInTheDocument();
});

test("members can read provider instructions in the sheet without creation controls", async () => {
  admin = false;
  mount([], [github]);
  await userEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
  const sheet = screen.getByRole("dialog", { name: "Connect GitHub" });
  expect(within(sheet).getByText(/Ask an admin to add this integration/)).toBeVisible();
  await userEvent.click(within(sheet).getByText("Setup help · GitHub"));
  expect(within(sheet).getByRole("region", { name: "GitHub capabilities" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Add integration" })).not.toBeInTheDocument();
  expect(within(sheet).queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  expect(within(sheet).queryByLabelText("Name")).not.toBeInTheDocument();
  expect(configureMcpIntegration).not.toHaveBeenCalled();
});

test("saving a new integration advances to account management in the same sheet", async () => {
  vi.mocked(configureMcpIntegration).mockResolvedValue(server);
  mount([]);
  await userEvent.click(await screen.findByRole("button", { name: "Add integration" }));
  await userEvent.type(screen.getByLabelText("Name"), "Support");
  await userEvent.type(screen.getByLabelText("Integration URL"), "https://mcp.example.com/");
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(configureMcpIntegration).toHaveBeenCalledWith("support", {
    server: { ...server.server, authentication: { type: "token", sharedAllowed: false } },
    enabled: false,
  });
  expect(await screen.findByText("Integration management: support")).toBeVisible();
  expect(screen.getByRole("dialog", { name: "Set up Support" })).toBeVisible();
  expect(screen.getByLabelText("Current route")).toHaveTextContent(/^\/$/);
});

test("local Knowledge setup remains available inside the provider sheet without approving access", async () => {
  vi.mocked(configureMcpIntegration).mockResolvedValue({
    server: GITHUB_KNOWLEDGE_PRESET,
    enabled: false,
    reviewed: { tools: [], resources: [], prompts: [] },
  });
  mount([], [github]);
  await openGitHubKnowledge();
  expect(screen.getByLabelText("Name")).toHaveValue("GitHub Knowledge (local)");
  await userEvent.click(screen.getByText("Advanced settings"));
  expect(screen.getByLabelText("Integration ID")).toHaveValue("github-knowledge");
  expect(screen.getByLabelText("Pinned container image")).toHaveValue(
    GITHUB_KNOWLEDGE_PRESET.transport.image
  );
  expect(screen.getByLabelText("Executable path")).toHaveValue("/server/github-mcp-server");
  expect(screen.getByLabelText("Arguments")).toHaveValue("stdio");
  expect(screen.getByLabelText("Allowed outbound hosts")).toHaveValue("api.github.com");
  expect(screen.getByLabelText("Required secret names")).toHaveValue(
    "GITHUB_PERSONAL_ACCESS_TOKEN"
  );
  expect(screen.getByLabelText("Allow shared accounts")).not.toBeChecked();
  expect(screen.queryByLabelText("Integration enabled")).not.toBeInTheDocument();
  expect(configureMcpIntegration).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(configureMcpIntegration).toHaveBeenCalledExactlyOnceWith("github-knowledge", {
    server: GITHUB_KNOWLEDGE_PRESET,
    enabled: false,
  });
  expect(await screen.findByText("Integration management: github-knowledge")).toBeVisible();
});

test("closing a local setup sheet clears its settings before opening the hosted setup", async () => {
  mount([], [github]);
  await openGitHubKnowledge();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
  expect(await screen.findByLabelText("Access token")).toBeVisible();
  expect(screen.queryByLabelText("Integration ID")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Pinned container image")).not.toBeInTheDocument();
  expect(configureMcpIntegration).not.toHaveBeenCalled();
});
