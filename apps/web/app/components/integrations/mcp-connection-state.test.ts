import type { McpAccountSummary } from "@tulipfarm/schema";
import { expect, test } from "vitest";
import { type McpConnectionData, mcpConnectionState } from "./mcp-connection-state";

const account: McpAccountSummary = {
  id: "personal",
  businessId: "business",
  integrationKey: "github-mcp",
  definitionDigest: "current",
  label: "GitHub account",
  owner: { scope: "personal", principalId: "user" },
  status: "active",
  authentication: "token",
  isDefault: false,
  revision: 1,
  expiresAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const data: McpConnectionData = {
  accounts: [account],
  configuration: {
    authentication: "token",
    requiredSlots: ["accessToken"],
    sharedAllowed: false,
    definitionDigest: "current",
  },
  error: null,
};

test("personal connection is independent of enablement and requires current credentials", () => {
  expect(mcpConnectionState(data).action).toBe("Manage");
  expect(mcpConnectionState({ ...data, accounts: [] }).action).toBe("Connect");
});
test.each(["pending", "revoked", "action_required"] as const)(
  "does not claim %s is connected",
  (status) => {
    expect(mcpConnectionState({ ...data, accounts: [{ ...account, status }] }).action).toBe(
      "Connect"
    );
  }
);
test.each([
  { expiresAt: "2020-01-01T00:00:00Z" },
  { definitionDigest: "old" },
  { owner: { scope: "shared" as const } },
])("does not substitute stale, expired, or shared credentials: %j", (patch) => {
  expect(mcpConnectionState({ ...data, accounts: [{ ...account, ...patch }] }).action).toBe(
    "Connect"
  );
});
test("unknown and failed loads never become false Connect", () => {
  expect(mcpConnectionState().action).toBe("Retry");
  expect(mcpConnectionState({ ...data, error: "Failed" }).action).toBe("Retry");
});
test("authless definitions have settings, not a fabricated personal connection", () => {
  expect(
    mcpConnectionState({
      ...data,
      accounts: [],
      configuration: {
        authentication: "none",
        requiredSlots: [],
        sharedAllowed: false,
        definitionDigest: "current",
      },
    })
  ).toEqual({ action: "Manage", description: "No sign-in required", connected: false });
});
