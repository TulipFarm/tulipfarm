import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpIntegrationDefinition } from "@tulipfarm/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { discoverMcpCapabilities, reviewMcpCapabilities } from "~/lib/mcp-integrations";
import { McpCapabilities } from "./mcp-capabilities";

vi.mock("~/lib/mcp-integrations", () => ({
  discoverMcpCapabilities: vi.fn(),
  reviewMcpCapabilities: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());

test("empty discovery presents one result instead of empty category headings", async () => {
  vi.mocked(discoverMcpCapabilities).mockResolvedValue({ tools: [], resources: [], prompts: [] });
  render(<McpCapabilities definition={definition} isAdmin onChanged={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Discover available access" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "No Tools, resources or prompts were found for this account."
  );
  expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save approved access" })).toBeVisible();
  expect(reviewMcpCapabilities).not.toHaveBeenCalled();
});

test("discovery only shows categories containing available items", async () => {
  vi.mocked(discoverMcpCapabilities).mockResolvedValue({ ...discovered, tools: [] });
  render(<McpCapabilities definition={definition} isAdmin onChanged={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Discover available access" }));
  expect(
    await screen.findByRole("heading", { name: "Resources — content agents can read" })
  ).toBeVisible();
  expect(screen.queryByRole("heading", { name: /^Tools —/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /^Prompts —/ })).not.toBeInTheDocument();
});

const definition: McpIntegrationDefinition = {
  server: {
    id: "support",
    label: "Support",
    transport: { type: "streamable-http", url: "https://mcp.example.com/" },
  },
  enabled: true,
  reviewed: { tools: [], resources: [], prompts: [] },
};
const discovered = {
  tools: [
    {
      name: "close_ticket",
      digest: "digest",
      inputSchema: {},
      mutating: true,
      requiresApproval: true,
    },
  ],
  resources: [{ name: "Handbook", uri: "docs://handbook", digest: "handbook-digest" }],
  prompts: [],
};

test("discovery does not approve new capabilities", async () => {
  vi.mocked(discoverMcpCapabilities).mockResolvedValue(discovered);
  render(<McpCapabilities definition={definition} isAdmin onChanged={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Discover available access" }));
  expect(
    await screen.findByRole("checkbox", { name: "Approve tools: close_ticket" })
  ).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Approve resources: Handbook" })).not.toBeChecked();
  expect(reviewMcpCapabilities).not.toHaveBeenCalled();
  expect(screen.getByText(/Discovery complete. Nothing new is approved yet/)).toBeVisible();
});

test("Tool action policy stays visible while raw inputs are disclosed separately", async () => {
  vi.mocked(discoverMcpCapabilities).mockResolvedValue(discovered);
  vi.mocked(reviewMcpCapabilities).mockResolvedValue(definition);
  render(<McpCapabilities definition={definition} isAdmin onChanged={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Discover available access" }));
  await userEvent.click(
    await screen.findByRole("checkbox", { name: "Approve tools: close_ticket" })
  );
  expect(screen.getByText("May change external data. Requires action approval.")).toBeVisible();
  expect(screen.getByText("{}")).not.toBeVisible();
  await userEvent.click(
    screen.getByRole("checkbox", { name: "Changes external data: close_ticket" })
  );
  await userEvent.click(screen.getByRole("checkbox", { name: "Require approval: close_ticket" }));
  await userEvent.click(screen.getByRole("button", { name: "Save approved access" }));
  expect(reviewMcpCapabilities).toHaveBeenCalledWith(
    "support",
    {
      tools: [{ ...discovered.tools[0], mutating: false, requiresApproval: false }],
      resources: [],
      prompts: [],
    },
    undefined
  );
});

test("saves only capabilities explicitly selected by the admin", async () => {
  vi.mocked(discoverMcpCapabilities).mockResolvedValue(discovered);
  vi.mocked(reviewMcpCapabilities).mockResolvedValue({
    ...definition,
    reviewed: { tools: [], resources: discovered.resources, prompts: [] },
  });
  const changed = vi.fn();
  render(<McpCapabilities definition={definition} isAdmin onChanged={changed} />);
  await userEvent.click(screen.getByRole("button", { name: "Discover available access" }));
  await userEvent.click(
    await screen.findByRole("checkbox", { name: "Approve resources: Handbook" })
  );
  await userEvent.click(screen.getByRole("button", { name: "Save approved access" }));
  expect(reviewMcpCapabilities).toHaveBeenCalledWith(
    "support",
    {
      tools: [],
      resources: discovered.resources,
      prompts: [],
    },
    undefined
  );
  expect(changed).toHaveBeenCalledOnce();
});

test("members can see approved capabilities but cannot expand them", () => {
  render(
    <McpCapabilities
      definition={{ ...definition, reviewed: discovered }}
      isAdmin={false}
      onChanged={vi.fn()}
    />
  );
  expect(screen.getByText("close_ticket")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Discover available access" })
  ).not.toBeInTheDocument();
});

test("discovery and review preserve the same explicitly selected Chat account context", async () => {
  vi.mocked(discoverMcpCapabilities).mockResolvedValue(discovered);
  vi.mocked(reviewMcpCapabilities).mockResolvedValue(definition);
  render(
    <McpCapabilities
      definition={definition}
      isAdmin
      context={{ chatId: "shared-chat" }}
      onChanged={vi.fn()}
    />
  );
  await userEvent.click(screen.getByRole("button", { name: "Discover available access" }));
  await screen.findByRole("checkbox", { name: "Approve resources: Handbook" });
  await userEvent.click(screen.getByRole("button", { name: "Save approved access" }));
  expect(discoverMcpCapabilities).toHaveBeenCalledWith("support", { chatId: "shared-chat" });
  expect(reviewMcpCapabilities).toHaveBeenCalledWith(
    "support",
    { tools: [], resources: [], prompts: [] },
    { chatId: "shared-chat" }
  );
});

test("rediscovery preserves the admin policy for an unchanged approved Tool", async () => {
  const tool = {
    name: "close_ticket",
    digest: "digest",
    inputSchema: {},
    mutating: false,
    requiresApproval: false,
  };
  vi.mocked(discoverMcpCapabilities).mockResolvedValue(discovered);
  vi.mocked(reviewMcpCapabilities).mockResolvedValue(definition);
  render(
    <McpCapabilities
      definition={{ ...definition, reviewed: { tools: [tool], resources: [], prompts: [] } }}
      isAdmin
      onChanged={vi.fn()}
    />
  );
  await userEvent.click(screen.getByRole("button", { name: "Discover available access" }));
  await userEvent.click(
    await screen.findByRole("checkbox", { name: "Approve resources: Handbook" })
  );
  await userEvent.click(screen.getByRole("button", { name: "Save approved access" }));
  expect(reviewMcpCapabilities).toHaveBeenCalledWith(
    "support",
    {
      tools: [tool],
      resources: discovered.resources,
      prompts: [],
    },
    undefined
  );
});

test("discovery and review keep the same explicit admin account outside Chat", async () => {
  vi.mocked(discoverMcpCapabilities).mockResolvedValue(discovered);
  vi.mocked(reviewMcpCapabilities).mockResolvedValue(definition);
  render(
    <McpCapabilities
      definition={definition}
      isAdmin
      context={{ accountId: "shared-exact" }}
      onChanged={vi.fn()}
    />
  );
  await userEvent.click(screen.getByRole("button", { name: "Discover available access" }));
  await screen.findByRole("checkbox", { name: "Approve resources: Handbook" });
  await userEvent.click(screen.getByRole("button", { name: "Save approved access" }));
  expect(discoverMcpCapabilities).toHaveBeenCalledWith("support", { accountId: "shared-exact" });
  expect(reviewMcpCapabilities).toHaveBeenCalledWith(
    "support",
    {
      tools: [],
      resources: [],
      prompts: [],
    },
    { accountId: "shared-exact" }
  );
});
