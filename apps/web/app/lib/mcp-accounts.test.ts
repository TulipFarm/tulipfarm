import { beforeEach, expect, test, vi } from "vitest";
import { apiGet, apiWrite } from "./api";
import {
  createMcpAccount,
  getMcpAccountConfiguration,
  getMcpAccountOAuthConfiguration,
  selectMcpChatAccount,
} from "./mcp-accounts";

vi.mock("./api", () => ({ apiGet: vi.fn(), apiWrite: vi.fn(), apiDelete: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

test("reads the exact callback URL for the encoded account without inferring its host", async () => {
  const configuration = { callbackUrl: "https://operator.example/api/oauth/callback" };
  vi.mocked(apiGet).mockResolvedValue(configuration);
  expect(await getMcpAccountOAuthConfiguration("support", "account/one")).toEqual(configuration);
  expect(apiGet).toHaveBeenCalledWith(
    "/api/v1/integrations/support/accounts/account%2Fone/oauth/configuration"
  );
});

test("reads account setup from the canonical API rather than deriving credential slots in the browser", async () => {
  const configuration = {
    authentication: "token",
    requiredSlots: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    sharedAllowed: false,
  };
  vi.mocked(apiGet).mockResolvedValue(configuration);
  expect(await getMcpAccountConfiguration("github-mcp")).toEqual(configuration);
  expect(apiGet).toHaveBeenCalledWith("/api/v1/integrations/github-mcp/accounts/configuration");
});

test("credential values occur only in the direct account mutation body", async () => {
  const input = {
    label: "My account",
    scope: "personal" as const,
    authentication: "token" as const,
    values: { accessToken: "fake-test-token" },
  };
  await createMcpAccount("support", input);
  expect(apiWrite).toHaveBeenCalledWith("POST", "/api/v1/integrations/support/accounts", input);
  expect(apiGet).not.toHaveBeenCalled();
});

test("persists the exact Chat account and explicit shared consent", async () => {
  await selectMcpChatAccount("chat-id", "support", {
    accountId: "account-two",
    confirmShared: true,
  });
  expect(apiWrite).toHaveBeenCalledWith(
    "PUT",
    "/api/v1/chats/chat-id/integrations/support/account",
    {
      accountId: "account-two",
      confirmShared: true,
    }
  );
});
