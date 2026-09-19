import { beforeEach, expect, test, vi } from "vitest";
import { apiGet, apiWrite } from "./api";
import {
  getMcpSetup,
  getMcpSetupEligibility,
  listMcpSetups,
  resumeMcpSetup,
  setupAccountInput,
  startMcpSetup,
} from "./mcp-setup";

vi.mock("./api", () => ({ apiGet: vi.fn(), apiWrite: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

test("start and resume address the exact durable operation without replaying initial consent", async () => {
  const input = { integrationKey: "github-mcp", accountId: "account", initializePolicy: true };
  await startMcpSetup("operation/id", input);
  await resumeMcpSetup("operation/id");
  expect(apiWrite).toHaveBeenNthCalledWith(
    1,
    "POST",
    "/api/v1/integration-setups/operation%2Fid",
    input
  );
  expect(apiWrite).toHaveBeenNthCalledWith(
    2,
    "POST",
    "/api/v1/integration-setups/operation%2Fid/resume",
    {}
  );
});

test("status and account-scoped restoration are read-only", async () => {
  vi.mocked(apiGet).mockResolvedValue({ operations: [] });
  await getMcpSetup("operation/id");
  await expect(listMcpSetups("github-mcp", "account/id")).resolves.toEqual([]);
  expect(apiGet).toHaveBeenNthCalledWith(1, "/api/v1/integration-setups/operation%2Fid");
  expect(apiGet).toHaveBeenNthCalledWith(
    2,
    "/api/v1/integration-setups?integrationKey=github-mcp&accountId=account%2Fid"
  );
  expect(apiWrite).not.toHaveBeenCalled();
});

test("eligibility uses the exact existing definition route and never mutates setup", async () => {
  await getMcpSetupEligibility("custom/setup");
  expect(apiGet).toHaveBeenCalledExactlyOnceWith("/api/v1/integrations/custom%2Fsetup/setup");
  expect(apiWrite).not.toHaveBeenCalled();
});

test("credentials are separate from persisted account intent and shared confirmation is explicit", () => {
  expect(
    setupAccountInput({
      label: "GitHub account",
      scope: "shared",
      authentication: "oauth",
      oauthClient: {
        clientId: "fixture-client",
        tokenEndpointAuthMethod: "client_secret_post",
        clientSecret: "fixture-secret",
      },
    })
  ).toEqual({
    account: {
      label: "GitHub account",
      scope: "shared",
      authentication: "oauth",
      oauthClient: { clientId: "fixture-client", tokenEndpointAuthMethod: "client_secret_post" },
    },
    clientSecret: "fixture-secret",
    confirmShared: true,
  });
});
