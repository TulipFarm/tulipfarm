import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GITHUB_KNOWLEDGE_PRESET, type McpIntegrationDefinition } from "@tulipfarm/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { configureMcpIntegration, type McpCatalogEntry } from "~/lib/mcp-integrations";
import IntegrationsIndex from "./_app.integrations._index";

let admin = true;
vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: () => admin }));
vi.mock("~/lib/mcp-integrations", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-integrations")>()),
  configureMcpIntegration: vi.fn(),
}));
beforeEach(() => {
  admin = true;
  vi.clearAllMocks();
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

function mount(servers = [server], entries: McpCatalogEntry[] = []) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: IntegrationsIndex,
      loader: () => ({
        servers,
        catalog: { entries, error: null },
        channels: [{ name: "slack", error: "Channel status unavailable.", integration: null }],
      }),
    },
    { path: "/integrations/:name", Component: () => <p>Integration detail</p> },
  ]);
  render(<Stub />);
}

test("retains the labelled example banner without claiming configured servers are connected", async () => {
  mount();
  const banner = await screen.findByRole("region", { name: "Integration capability examples" });
  expect(within(banner).getByText("Example activity")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Manage Support" })).toHaveAttribute(
    "href",
    "/integrations/support"
  );
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
});

test("filters servers and clears search without obsolete package actions", async () => {
  mount();
  await userEvent.type(await screen.findByLabelText("Search integrations"), "zzzz");
  expect(screen.getByText("Nothing matches that search")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByText("Support")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Install from source" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Package security" })).not.toBeInTheDocument();
});

test("native channel failures remain visible beside working MCP management", async () => {
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Channel status unavailable.");
  expect(screen.getByRole("link", { name: "Manage Support" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry channel status" })).toBeInTheDocument();
});

test("members do not receive server-creation controls", async () => {
  admin = false;
  mount();
  await screen.findByText("Support");
  expect(screen.queryByRole("button", { name: "Add MCP server" })).not.toBeInTheDocument();
});

test("adding a server from the mounted catalog navigates to its actual management route", async () => {
  vi.mocked(configureMcpIntegration).mockResolvedValue(server);
  mount([]);
  await userEvent.click(await screen.findByRole("button", { name: "Add MCP server" }));
  await userEvent.type(screen.getByLabelText("Integration ID"), "support");
  await userEvent.type(screen.getByLabelText("Display name"), "Support");
  await userEvent.type(screen.getByLabelText("Remote MCP URL"), "https://mcp.example.com/");
  await userEvent.click(screen.getByRole("button", { name: "Add server" }));
  expect(configureMcpIntegration).toHaveBeenCalledWith("support", {
    server: {
      ...server.server,
      authentication: { type: "token", sharedAllowed: false },
    },
    enabled: false,
  });
  expect(await screen.findByText("Integration detail")).toBeInTheDocument();
});

test("local GitHub Knowledge setup fills exact inputs and creates only a disabled unreviewed server", async () => {
  vi.mocked(configureMcpIntegration).mockResolvedValue({
    server: GITHUB_KNOWLEDGE_PRESET,
    enabled: false,
    reviewed: { tools: [], resources: [], prompts: [] },
  });
  mount([], [github]);
  await userEvent.click(
    await screen.findByRole("button", { name: "Set up GitHub Knowledge (local)" })
  );
  expect(screen.getByLabelText("Integration ID")).toHaveValue("github-knowledge");
  expect(screen.getByLabelText("Display name")).toHaveValue("GitHub Knowledge (local)");
  expect(screen.getByLabelText("Pinned container image")).toHaveValue(
    GITHUB_KNOWLEDGE_PRESET.transport.image
  );
  expect(screen.getByLabelText("Executable path")).toHaveValue("/server/github-mcp-server");
  expect(screen.getByLabelText("Arguments")).toHaveValue("stdio");
  expect(screen.getByLabelText("Allowed outbound hosts")).toHaveValue("api.github.com");
  expect(screen.getByLabelText("Credential environment names")).toHaveValue(
    "GITHUB_PERSONAL_ACCESS_TOKEN"
  );
  expect(screen.getByLabelText("Permit admin-managed shared accounts")).not.toBeChecked();
  expect(screen.getByLabelText("Enable this MCP server")).not.toBeChecked();
  expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  expect(configureMcpIntegration).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Add server" }));
  expect(configureMcpIntegration).toHaveBeenCalledExactlyOnceWith("github-knowledge", {
    server: GITHUB_KNOWLEDGE_PRESET,
    enabled: false,
  });
  expect(await screen.findByText("Integration detail")).toBeInTheDocument();
});

test("choosing remote GitHub after cancelling the local preset clears the local configuration", async () => {
  mount([], [github]);
  await userEvent.click(
    await screen.findByRole("button", { name: "Set up GitHub Knowledge (local)" })
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Set up GitHub" }));
  expect(screen.getByLabelText("Integration ID")).toHaveValue("github-mcp");
  expect(screen.getByLabelText("Remote MCP URL")).toHaveValue(github.url);
  expect(screen.queryByLabelText("Pinned container image")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Credential environment names")).not.toBeInTheDocument();
  expect(configureMcpIntegration).not.toHaveBeenCalled();
});

test("members see the local Knowledge limits without gaining preset creation controls", async () => {
  admin = false;
  mount([], [github]);
  expect(await screen.findByText(/Shared token accounts and remote GitHub/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Set up GitHub Knowledge (local)" })
  ).not.toBeInTheDocument();
});
