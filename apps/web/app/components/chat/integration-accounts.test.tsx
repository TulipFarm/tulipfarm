import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpAccountSummary } from "@tulipfarm/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { getMcpChatAccount, listMcpAccounts, selectMcpChatAccount } from "~/lib/mcp-accounts";
import { listMcpIntegrations } from "~/lib/mcp-integrations";
import { ChatIntegrationAccounts } from "./integration-accounts";

vi.mock("~/lib/mcp-accounts", () => ({
  getMcpChatAccount: vi.fn(),
  listMcpAccounts: vi.fn(),
  selectMcpChatAccount: vi.fn(),
}));
vi.mock("~/lib/mcp-integrations", () => ({ listMcpIntegrations: vi.fn() }));

const account: McpAccountSummary = {
  id: "shared-exact-id",
  integrationKey: "support",
  businessId: "business",
  definitionDigest: "a".repeat(64),
  label: "Support shared",
  owner: { scope: "shared" },
  authentication: "token",
  status: "active",
  isDefault: true,
  revision: 1,
  expiresAt: null,
  createdAt: "2026-09-18T00:00:00Z",
  updatedAt: "2026-09-18T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listMcpIntegrations).mockResolvedValue([
    {
      server: {
        id: "support",
        label: "Support",
        transport: { type: "streamable-http", url: "https://mcp.example.com/" },
      },
      enabled: true,
      reviewed: { tools: [], resources: [], prompts: [] },
    },
  ]);
  vi.mocked(listMcpAccounts).mockResolvedValue([account]);
});

function mount(chatId: string | undefined = "chat-1") {
  const Stub = createRemixStub([
    { path: "/", Component: () => <ChatIntegrationAccounts chatId={chatId} disabled={false} /> },
  ]);
  render(<Stub />);
}

test("shows the exact persisted shared identity without asking for consent again", async () => {
  vi.mocked(getMcpChatAccount).mockResolvedValue(account);
  mount();
  expect(
    await screen.findByText(/Support: Support shared · shared · shared-exact-id/)
  ).toBeInTheDocument();
  expect(selectMcpChatAccount).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Confirm shared account" })).not.toBeInTheDocument();
});

test("failed personal access never silently falls back to a shared account", async () => {
  vi.mocked(getMcpChatAccount).mockRejectedValue(
    new ApiError(409, "Account expired", undefined, "account_expired")
  );
  mount();
  await userEvent.click(await screen.findByText("Integration accounts"));
  expect(await screen.findByRole("alert")).toHaveTextContent("This account has expired.");
  expect(selectMcpChatAccount).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("combobox", { name: "Support account" }));
  await userEvent.click(await screen.findByRole("option", { name: /Support shared/ }));
  expect(selectMcpChatAccount).not.toHaveBeenCalled();
  vi.mocked(selectMcpChatAccount).mockResolvedValue(undefined);
  vi.mocked(getMcpChatAccount).mockResolvedValue(account);
  await userEvent.click(screen.getByRole("button", { name: "Confirm shared account" }));
  expect(selectMcpChatAccount).toHaveBeenCalledWith("chat-1", "support", {
    accountId: "shared-exact-id",
    confirmShared: true,
  });
});

test("does not resolve a Chat account before a Chat exists", () => {
  const Stub = createRemixStub([
    { path: "/", Component: () => <ChatIntegrationAccounts disabled={false} /> },
  ]);
  render(<Stub />);
  expect(listMcpIntegrations).not.toHaveBeenCalled();
  expect(getMcpChatAccount).not.toHaveBeenCalled();
});
