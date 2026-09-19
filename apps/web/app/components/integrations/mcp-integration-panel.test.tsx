import { createRemixStub } from "@remix-run/testing";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpAccountSummary, McpIntegrationDefinition } from "@tulipfarm/schema";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { createMcpAccount, getMcpAccountConfiguration, listMcpAccounts } from "~/lib/mcp-accounts";
import { getMcpIntegration, removeMcpIntegration } from "~/lib/mcp-integrations";
import {
  getMcpSetupEligibility,
  listMcpSetups,
  resumeMcpSetup,
  startMcpSetup,
} from "~/lib/mcp-setup";
import { McpIntegrationPanel } from "./mcp-integration-panel";
import { githubEligibilityFixture as eligibility } from "./mcp-setup.fixtures";

vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: () => true }));
vi.mock("~/lib/mcp-accounts", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-accounts")>()),
  getMcpAccountConfiguration: vi.fn(),
  listMcpAccounts: vi.fn(),
  createMcpAccount: vi.fn(),
}));
vi.mock("~/lib/mcp-setup", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-setup")>()),
  startMcpSetup: vi.fn(),
  resumeMcpSetup: vi.fn(),
  listMcpSetups: vi.fn(),
  getMcpSetupEligibility: vi.fn(),
}));
vi.mock("~/lib/mcp-integrations", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-integrations")>()),
  getMcpIntegration: vi.fn(),
  removeMcpIntegration: vi.fn(),
}));

const definition: McpIntegrationDefinition = {
  server: {
    id: "support",
    label: "Support",
    transport: { type: "streamable-http", url: "https://provider.example/integration" },
    authentication: { type: "token", sharedAllowed: false },
  },
  enabled: false,
  reviewPolicy: "uninitialized",
  reviewed: { tools: [], resources: [], prompts: [] },
};
const account: McpAccountSummary = {
  id: "personal-support",
  integrationKey: "support",
  businessId: "business",
  definitionDigest: "a".repeat(64),
  label: "My support",
  owner: { scope: "personal", principalId: "user" },
  authentication: "token",
  status: "active",
  isDefault: false,
  revision: 1,
  expiresAt: null,
  createdAt: "2026-09-18T00:00:00Z",
  updatedAt: "2026-09-18T00:00:00Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getMcpIntegration).mockResolvedValue(definition);
  vi.mocked(listMcpAccounts).mockResolvedValue([]);
  vi.mocked(listMcpSetups).mockResolvedValue([]);
  vi.mocked(getMcpSetupEligibility).mockResolvedValue(eligibility);
  vi.mocked(getMcpAccountConfiguration).mockResolvedValue({
    authentication: "token",
    requiredSlots: ["providerToken"],
    sharedAllowed: false,
  });
});

function mount({ embedded = true, switchable = false } = {}) {
  const changed = vi.fn();
  const removed = vi.fn();
  const Stub = createRemixStub([
    {
      path: "/",
      Component: function PanelHost() {
        const [serverId, setServerId] = useState("support");
        return (
          <>
            {switchable && (
              <button type="button" onClick={() => setServerId("second")}>
                Switch integration
              </button>
            )}
            <McpIntegrationPanel
              serverId={serverId}
              embedded={embedded}
              onChanged={changed}
              onRemoved={removed}
            />
          </>
        );
      },
    },
  ]);
  return { ...render(<Stub />), changed, removed };
}

test("shows loading then embedded detail with trusted credential metadata", async () => {
  const { changed } = mount();
  expect(screen.getByRole("status")).toHaveTextContent("Loading integration...");
  const token = await screen.findByLabelText("providerToken");
  expect(token).toHaveAttribute("type", "password");
  expect(getMcpIntegration).toHaveBeenCalledExactlyOnceWith("support");
  expect(listMcpAccounts).toHaveBeenCalledExactlyOnceWith("support");
  expect(getMcpAccountConfiguration).toHaveBeenCalledExactlyOnceWith("support");
  expect(getMcpSetupEligibility).toHaveBeenCalledExactlyOnceWith("support");
  expect(vi.mocked(getMcpSetupEligibility).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(getMcpAccountConfiguration).mock.invocationCallOrder[0] ?? 0
  );
  expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Back to Integrations" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Support" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Connect your account" })).toBeVisible();
  expect(screen.queryByText("Disabled")).not.toBeInTheDocument();
  expect(createMcpAccount).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

test("explicitly using current settings does not restore the abandoned consent after reloading", async () => {
  vi.mocked(listMcpAccounts).mockResolvedValue([account]);
  vi.mocked(listMcpSetups).mockResolvedValue([
    {
      id: "11111111-1111-4111-8111-111111111111",
      integrationKey: "support",
      accountId: account.id,
      status: "needs_admin",
      error: "initial_consent_required",
    },
  ]);
  vi.mocked(startMcpSetup).mockImplementation(async (id) => ({
    id,
    integrationKey: "support",
    accountId: account.id,
    status: "done",
  }));
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "Use current settings" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Finish connecting" })).toBeEnabled()
  );
  expect(getMcpSetupEligibility).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/Every initial Tool call/)).toBeVisible();
  expect(startMcpSetup).not.toHaveBeenCalled();
  expect(resumeMcpSetup).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Finish connecting" }));
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(startMcpSetup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
    integrationKey: "support",
    accountId: account.id,
    definitionRevision: eligibility.definitionRevision,
    initializePolicy: true,
  });
  expect(vi.mocked(startMcpSetup).mock.calls[0]?.[0]).not.toBe(
    "11111111-1111-4111-8111-111111111111"
  );
});

test("eligibility failures block setup and retry only reads current permissions", async () => {
  vi.mocked(getMcpSetupEligibility).mockRejectedValueOnce(
    new Error("Setup permissions unavailable")
  );
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Setup permissions unavailable");
  expect(screen.queryByLabelText("providerToken")).not.toBeInTheDocument();
  expect(screen.queryByText("Ready to use")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Reload setup permissions" }));
  expect(await screen.findByLabelText("providerToken")).toBeVisible();
  expect(getMcpSetupEligibility).toHaveBeenCalledTimes(2);
  expect(startMcpSetup).not.toHaveBeenCalled();
  expect(createMcpAccount).not.toHaveBeenCalled();
});

test("stale preview rejection clears credentials and explicitly reloads the authoritative revision and policy", async () => {
  vi.mocked(startMcpSetup)
    .mockRejectedValueOnce(new ApiError(409, "Settings changed", undefined, "definition_changed"))
    .mockImplementationOnce(async (id) => ({
      id,
      integrationKey: "support",
      accountId: account.id,
      status: "done",
    }));
  mount();
  await userEvent.type(await screen.findByLabelText("providerToken"), "first-fixture-token");
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("changed before setup started");
  expect(screen.queryByDisplayValue("first-fixture-token")).not.toBeInTheDocument();
  expect(vi.mocked(startMcpSetup).mock.calls[0]?.[1]).toMatchObject({
    definitionRevision: eligibility.definitionRevision,
    initializePolicy: true,
  });
  vi.mocked(getMcpSetupEligibility).mockResolvedValue({
    ...eligibility,
    definitionRevision: "d".repeat(64),
    policy: "preserve",
  });
  vi.mocked(getMcpIntegration).mockResolvedValue({ ...definition, reviewPolicy: "custom" });
  await userEvent.click(screen.getByRole("button", { name: "Reload setup permissions" }));
  await userEvent.type(await screen.findByLabelText("providerToken"), "replacement-fixture-token");
  expect(startMcpSetup).toHaveBeenCalledOnce();
  expect(screen.queryByText(/Every initial Tool call/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(vi.mocked(startMcpSetup).mock.calls[1]?.[1]).toMatchObject({
    definitionRevision: "d".repeat(64),
    initializePolicy: false,
    values: { providerToken: "replacement-fixture-token" },
  });
  expect(createMcpAccount).not.toHaveBeenCalled();
});

test("standalone presentation retains the integration heading and back link", async () => {
  mount({ embedded: false });
  expect(await screen.findByRole("heading", { name: "Support" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Back to Integrations" })).toHaveAttribute(
    "href",
    "/integrations"
  );
});

test("failed integration load has an explicit retry without inventing account fields", async () => {
  vi.mocked(getMcpIntegration)
    .mockRejectedValueOnce(new Error("Integration is unavailable."))
    .mockResolvedValueOnce(definition);
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Integration is unavailable.");
  expect(screen.queryByLabelText("providerToken")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Connect account" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry integration" }));
  expect(await screen.findByLabelText("providerToken")).toHaveAttribute("type", "password");
  expect(getMcpIntegration).toHaveBeenCalledTimes(2);
});

test("account and setup failures remain visible and retry uses fresh trusted metadata", async () => {
  vi.mocked(listMcpAccounts).mockRejectedValueOnce(new Error("Account list unavailable."));
  vi.mocked(getMcpAccountConfiguration).mockRejectedValueOnce(
    new Error("Account setup unavailable.")
  );
  mount();
  await screen.findByText("Account list unavailable.");
  expect(screen.getByText("Account setup unavailable.")).toBeVisible();
  expect(screen.queryByLabelText("providerToken")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Reload account setup" }));
  expect(await screen.findByLabelText("providerToken")).toBeVisible();
  expect(getMcpAccountConfiguration).toHaveBeenCalledTimes(2);
  expect(listMcpAccounts).toHaveBeenCalledTimes(2);
  expect(createMcpAccount).not.toHaveBeenCalled();
});

test("creating an account preserves metadata keys and refreshes the panel and catalog", async () => {
  vi.mocked(startMcpSetup).mockImplementation(async (id) => {
    vi.mocked(listMcpAccounts).mockResolvedValue([account]);
    return { id, integrationKey: "support", accountId: account.id, status: "done" };
  });

  const { changed } = mount();
  await userEvent.click(await screen.findByText("Account preferences"));
  await userEvent.clear(screen.getByLabelText("Account name"));
  await userEvent.type(screen.getByLabelText("Account name"), "My support");
  await userEvent.type(screen.getByLabelText("providerToken"), "fake-provider-token");
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(startMcpSetup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
    integrationKey: "support",
    definitionRevision: eligibility.definitionRevision,
    account: { label: "My support", scope: "personal", authentication: "token" },
    values: { providerToken: "fake-provider-token" },
    initializePolicy: true,
  });
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(createMcpAccount).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
  await waitFor(() => expect(getMcpIntegration).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(getMcpAccountConfiguration).toHaveBeenCalledTimes(2));
});

test("a failed pending-token probe refreshes its saved state and retries the same account", async () => {
  const failed = { ...account, status: "action_required" as const, revision: 2 };
  vi.mocked(listMcpAccounts).mockResolvedValue([{ ...account, status: "pending" }]);
  vi.mocked(startMcpSetup).mockImplementationOnce(async (id) => {
    vi.mocked(listMcpAccounts).mockResolvedValue([failed]);
    return {
      id,
      integrationKey: "support",
      accountId: account.id,
      status: "needs_credentials",
      error: "probe_failed",
    };
  });
  mount();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Finish connecting" })).toBeEnabled()
  );
  await userEvent.click(screen.getByRole("button", { name: "Finish connecting" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The provider could not verify this account"
  );
  expect(screen.queryByText("Finish sign-in")).not.toBeInTheDocument();
  vi.mocked(resumeMcpSetup).mockImplementationOnce(async (id) => {
    const active = { ...account, revision: 3 };
    vi.mocked(listMcpAccounts).mockResolvedValue([active]);
    return { id, integrationKey: "support", accountId: account.id, status: "done" };
  });
  await userEvent.type(screen.getByLabelText("providerToken"), "fake-second-token");
  await userEvent.click(screen.getByRole("button", { name: "Continue connecting" }));
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(startMcpSetup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
    integrationKey: "support",
    definitionRevision: eligibility.definitionRevision,
    accountId: account.id,
    initializePolicy: true,
  });
  expect(resumeMcpSetup).toHaveBeenCalledExactlyOnceWith(
    vi.mocked(startMcpSetup).mock.calls[0]?.[0],
    {
      values: { providerToken: "fake-second-token" },
    }
  );
  expect(createMcpAccount).not.toHaveBeenCalled();
});

test("switching integrations cannot publish an older request into the current panel", async () => {
  let resolveFirst: ((value: McpIntegrationDefinition) => void) | undefined;
  vi.mocked(getMcpIntegration).mockImplementation((id) =>
    id === "support"
      ? new Promise((resolve) => {
          resolveFirst = resolve;
        })
      : Promise.resolve({
          ...definition,
          server: { ...definition.server, id: "second", label: "Second" },
        })
  );
  vi.mocked(getMcpAccountConfiguration).mockImplementation(async (id) => ({
    authentication: "token",
    requiredSlots: [id === "support" ? "firstToken" : "secondToken"],
    sharedAllowed: false,
  }));
  mount({ switchable: true });
  await userEvent.click(screen.getByRole("button", { name: "Switch integration" }));
  expect(await screen.findByLabelText("secondToken")).toBeVisible();
  await act(async () => resolveFirst?.(definition));
  expect(screen.getByLabelText("secondToken")).toBeVisible();
  expect(screen.queryByLabelText("firstToken")).not.toBeInTheDocument();
});

test("unmounting a loading panel ignores its eventual result", async () => {
  let resolve: ((value: McpIntegrationDefinition) => void) | undefined;
  vi.mocked(getMcpIntegration).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    })
  );
  const { unmount, changed, removed } = mount();
  expect(screen.getByRole("status")).toHaveTextContent("Loading integration...");
  unmount();
  await act(async () => resolve?.(definition));
  expect(screen.queryByLabelText("providerToken")).not.toBeInTheDocument();
  expect(changed).not.toHaveBeenCalled();
  expect(removed).not.toHaveBeenCalled();
});

test("removing an integration notifies the sheet without navigating or reloading a deleted definition", async () => {
  vi.mocked(removeMcpIntegration).mockResolvedValue(undefined);
  const { changed, removed } = mount();
  await screen.findByLabelText("providerToken");
  await userEvent.click(screen.getByText("Advanced settings"));
  await userEvent.click(screen.getByRole("button", { name: "Remove integration" }));
  expect(removeMcpIntegration).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Confirm remove integration" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Integration removed.");
  await waitFor(() => expect(removed).toHaveBeenCalledOnce());
  expect(changed).toHaveBeenCalledOnce();
  expect(getMcpIntegration).toHaveBeenCalledOnce();
});
