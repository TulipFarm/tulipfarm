import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpAccountSummary, McpIntegrationDefinition } from "@tulipfarm/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { createMcpAccount } from "~/lib/mcp-accounts";
import {
  discoverMcpCapabilities,
  readMcpResource,
  reviewMcpCapabilities,
} from "~/lib/mcp-integrations";
import { McpServerDetail } from "./mcp-server-detail";

let admin = false;
vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: () => admin }));
vi.mock("~/lib/mcp-accounts", () => ({ createMcpAccount: vi.fn() }));
vi.mock("~/lib/mcp-integrations", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-integrations")>()),
  discoverMcpCapabilities: vi.fn(),
  reviewMcpCapabilities: vi.fn(),
  readMcpResource: vi.fn(),
}));

const definition: McpIntegrationDefinition = {
  server: {
    id: "support",
    label: "Support",
    transport: { type: "streamable-http", url: "https://mcp.example.com/" },
  },
  enabled: false,
  reviewed: { tools: [], resources: [], prompts: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  admin = false;
});

function mount(
  configuration?: {
    authentication: "token";
    requiredSlots: string[];
    sharedAllowed: boolean;
  },
  accounts: McpAccountSummary[] = [],
  currentDefinition = definition
) {
  const changed = vi.fn();
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <McpServerDetail
          definition={currentDefinition}
          accounts={accounts}
          accountConfiguration={configuration}
          onChanged={changed}
          onRemoved={vi.fn()}
        />
      ),
    },
  ]);
  render(<Stub />);
  return changed;
}

test("server management mounts personal account creation from trusted field metadata", async () => {
  vi.mocked(createMcpAccount).mockResolvedValue({
    id: "my-account",
    integrationKey: "support",
    businessId: "business",
    definitionDigest: "a".repeat(64),
    label: "My support account",
    owner: { scope: "personal", principalId: "user" },
    authentication: "token",
    status: "action_required",
    isDefault: false,
    revision: 1,
    expiresAt: null,
    createdAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
  });
  const changed = mount({
    authentication: "token",
    requiredSlots: ["providerToken"],
    sharedAllowed: false,
  });
  await userEvent.type(await screen.findByLabelText("Account label"), "My support account");
  await userEvent.type(screen.getByLabelText("providerToken"), "fake-test-token");
  await userEvent.click(screen.getByRole("button", { name: "Connect account" }));
  expect(createMcpAccount).toHaveBeenCalledWith("support", {
    label: "My support account",
    authentication: "token",
    scope: "personal",
    isDefault: false,
    values: { providerToken: "fake-test-token" },
  });
  expect(changed).toHaveBeenCalledOnce();
  expect(await screen.findByRole("status")).toHaveTextContent("Further setup is required.");
  expect(screen.queryByText("Account connected.")).not.toBeInTheDocument();
});

test("missing server metadata never guesses a token field or sends an account request", async () => {
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Account setup is not available.");
  expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Connect account" })).not.toBeInTheDocument();
  expect(createMcpAccount).not.toHaveBeenCalled();
});

test("admin shared discovery requires exact account choice and never enables shared content previews", async () => {
  admin = true;
  const account: McpAccountSummary = {
    id: "shared-exact",
    integrationKey: "support",
    businessId: "business",
    definitionDigest: "a".repeat(64),
    label: "Shared support",
    owner: { scope: "shared" },
    authentication: "token",
    status: "active",
    isDefault: true,
    revision: 1,
    expiresAt: null,
    createdAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
  };
  const reviewed = {
    tools: [],
    resources: [{ name: "Handbook", uri: "docs://handbook", digest: "digest" }],
    prompts: [],
  };
  vi.mocked(discoverMcpCapabilities).mockResolvedValue(reviewed);
  vi.mocked(reviewMcpCapabilities).mockResolvedValue(definition);
  mount(
    { authentication: "token", requiredSlots: ["accessToken"], sharedAllowed: true },
    [account],
    { ...definition, enabled: true, reviewed }
  );
  expect(screen.getByRole("button", { name: "Discover capabilities" })).toBeDisabled();
  expect(discoverMcpCapabilities).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("combobox", { name: "Setup account" }));
  await userEvent.click(await screen.findByRole("option", { name: /Shared support/ }));
  await userEvent.click(screen.getByRole("button", { name: "Discover capabilities" }));
  await screen.findByRole("checkbox", { name: "Approve resources: Handbook" });
  await userEvent.click(screen.getByRole("button", { name: "Save approved capabilities" }));
  expect(discoverMcpCapabilities).toHaveBeenCalledWith("support", { accountId: "shared-exact" });
  expect(reviewMcpCapabilities).toHaveBeenCalledWith("support", reviewed, {
    accountId: "shared-exact",
  });
  expect(screen.getByRole("combobox", { name: "Approved resource" })).toBeDisabled();
  expect(readMcpResource).not.toHaveBeenCalled();
});
