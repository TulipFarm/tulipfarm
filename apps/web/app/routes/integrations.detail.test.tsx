import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpAccountSummary } from "@tulipfarm/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { getGitHubStatus, getIntegration, listSlackRoutes } from "~/lib/integrations";
import { createMcpAccount, getMcpAccountConfiguration, listMcpAccounts } from "~/lib/mcp-accounts";
import { getMcpIntegration } from "~/lib/mcp-integrations";
import IntegrationDetailPage, { clientLoader } from "./_app.integrations.$name";

vi.mock("~/lib/integrations", async (original) => ({
  ...(await original<typeof import("~/lib/integrations")>()),
  getIntegration: vi.fn(),
  getGitHubStatus: vi.fn(),
  listSlackRoutes: vi.fn(),
}));
vi.mock("~/lib/mcp-accounts", () => ({
  listMcpAccounts: vi.fn(),
  getMcpAccountConfiguration: vi.fn(),
  createMcpAccount: vi.fn(),
}));
vi.mock("~/lib/mcp-integrations", () => ({ getMcpIntegration: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMcpAccountConfiguration).mockResolvedValue({
    authentication: "token",
    requiredSlots: ["accessToken"],
    sharedAllowed: false,
  });
});

test("native GitHub callback URLs retain channel setup and expose status failures", async () => {
  vi.mocked(getIntegration).mockResolvedValue({
    name: "github",
    type: "none",
    installed: true,
    status: "disconnected",
    connected: false,
    manifest: {},
    auth: [],
    grants: [],
  });

  vi.mocked(getGitHubStatus).mockRejectedValue(new Error("Channel status unavailable."));
  const result = await clientLoader({
    params: { name: "github" },
    request: new Request("http://localhost/integrations/github?status=connected"),
    context: undefined,
    serverLoader: async () => {
      throw new Error("This SPA route must not invoke a server loader.");
    },
  });
  expect(result.kind).toBe("channel");
  if (result.kind !== "channel") throw new Error("Expected native channel details.");
  expect(result.routesError).toBe("Channel status unavailable.");
  expect(result.integration.name).toBe("github");
  expect(listSlackRoutes).not.toHaveBeenCalled();
});

test("the GitHub MCP ID loads MCP management without using native channel APIs", async () => {
  vi.mocked(getMcpIntegration).mockResolvedValue({
    server: {
      id: "github-mcp",
      label: "GitHub MCP",
      transport: { type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" },
    },
    enabled: false,
    reviewed: { tools: [], resources: [], prompts: [] },
  });
  vi.mocked(listMcpAccounts).mockRejectedValue(new Error("Account access unavailable."));
  const result = await clientLoader({
    params: { name: "github-mcp" },
    request: new Request("http://localhost/integrations/github-mcp"),
    context: undefined,
    serverLoader: async () => {
      throw new Error("This SPA route must not invoke a server loader.");
    },
  });
  expect(result.kind).toBe("mcp");
  if (result.kind !== "mcp") throw new Error("Expected MCP management.");
  expect(result.definition.server.id).toBe("github-mcp");
  expect(result.accounts.error).toBe("Account access unavailable.");
  expect(result.configuration.value).toEqual({
    authentication: "token",
    requiredSlots: ["accessToken"],
    sharedAllowed: false,
  });
  expect(getIntegration).not.toHaveBeenCalled();
});

function mountMcpRoute() {
  vi.mocked(getMcpIntegration).mockResolvedValue({
    server: {
      id: "support",
      label: "Support",
      transport: { type: "streamable-http", url: "https://mcp.example.com/" },
      authentication: { type: "token", sharedAllowed: false },
    },
    enabled: false,
    reviewed: { tools: [], resources: [], prompts: [] },
  });
  vi.mocked(listMcpAccounts).mockResolvedValue([]);
  const Stub = createRemixStub([
    {
      path: "/integrations/:name",
      Component: IntegrationDetailPage,
      loader: ({ request, params }) =>
        clientLoader({
          request,
          params,
          context: undefined,
          serverLoader: async () => {
            throw new Error("No server loader in this SPA.");
          },
        }),
    },
  ]);
  render(<Stub initialEntries={["/integrations/support"]} />);
}

test("the mounted detail route loads canonical account metadata and submits a personal account", async () => {
  const account: McpAccountSummary = {
    id: "account",
    integrationKey: "support",
    businessId: "business",
    definitionDigest: "a".repeat(64),
    label: "My account",
    owner: { scope: "personal", principalId: "user" },
    authentication: "token",
    status: "active",
    isDefault: false,
    revision: 1,
    expiresAt: null,
    createdAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
  };
  vi.mocked(createMcpAccount).mockImplementation(async () => {
    vi.mocked(listMcpAccounts).mockResolvedValue([account]);
    return account;
  });
  mountMcpRoute();
  await userEvent.type(await screen.findByLabelText("Account label"), "My account");
  expect(getMcpAccountConfiguration).toHaveBeenCalledWith("support");
  expect(screen.getByLabelText("Access token")).toHaveAttribute("type", "password");
  await userEvent.type(screen.getByLabelText("Access token"), "fake-test-token");
  await userEvent.click(screen.getByRole("button", { name: "Connect account" }));
  expect(createMcpAccount).toHaveBeenCalledWith("support", {
    label: "My account",
    scope: "personal",
    authentication: "token",
    isDefault: false,
    values: { accessToken: "fake-test-token" },
  });
  expect(await screen.findByText("My account")).toBeInTheDocument();
  expect(screen.getByLabelText("Access token")).toHaveValue("");
});

test("the mounted route fails closed when canonical credential metadata is unavailable", async () => {
  vi.mocked(getMcpAccountConfiguration).mockRejectedValue(
    new Error("Account setup is unavailable.")
  );
  mountMcpRoute();
  expect(await screen.findByRole("alert")).toHaveTextContent("Account setup is unavailable.");
  expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Connect account" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reload account setup" })).toBeInTheDocument();
});
