import { beforeEach, expect, test, vi } from "vitest";
import { apiWrite } from "./api";
import {
  discoverMcpCapabilities,
  readMcpResource,
  renderMcpPrompt,
  reviewMcpCapabilities,
} from "./mcp-integrations";

vi.mock("./api", () => ({ apiGet: vi.fn(), apiWrite: vi.fn(), apiDelete: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const capabilities = { tools: [], resources: [], prompts: [] };

test("discovery and capability review preserve an exact explicit account, never a Chat default", async () => {
  vi.mocked(apiWrite).mockResolvedValueOnce({ capabilities }).mockResolvedValueOnce({ server: {} });
  await discoverMcpCapabilities("support", { accountId: "account/one" });
  await reviewMcpCapabilities("support", capabilities, { accountId: "account/one" });
  expect(apiWrite).toHaveBeenNthCalledWith(1, "POST", "/api/v1/integrations/support/discover", {
    accountId: "account/one",
  });
  expect(apiWrite).toHaveBeenNthCalledWith(
    2,
    "PUT",
    "/api/v1/integrations/support/capabilities?accountId=account%2Fone",
    capabilities
  );
});

test("content reads submit either exact personal account identity or persisted Chat context", async () => {
  await readMcpResource("support", "docs://handbook", { accountId: "personal-exact" });
  await renderMcpPrompt("support", "Review", { topic: "report" }, { chatId: "chat-exact" });
  expect(apiWrite).toHaveBeenNthCalledWith(
    1,
    "POST",
    "/api/v1/integrations/support/resources/read",
    {
      uri: "docs://handbook",
      accountId: "personal-exact",
    }
  );
  expect(apiWrite).toHaveBeenNthCalledWith(
    2,
    "POST",
    "/api/v1/integrations/support/prompts/render",
    {
      name: "Review",
      arguments: { topic: "report" },
      chatId: "chat-exact",
    }
  );
});
