import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import {
  createMcpAccount,
  getMcpAccountOAuthConfiguration,
  listMcpAccounts,
  startMcpAccountOAuth,
  updateMcpAccount,
} from "~/lib/mcp-accounts";
import {
  configureMcpIntegration,
  discoverMcpCapabilities,
  reviewMcpCapabilities,
} from "~/lib/mcp-integrations";
import { getMcpSetup, listMcpSetups, resumeMcpSetup, startMcpSetup } from "~/lib/mcp-setup";
import { McpServerDetail } from "./mcp-server-detail";
import {
  githubAccessFixture as access,
  githubAccountFixture as account,
  githubDefinitionFixture as definition,
  githubEligibilityFixture as eligibility,
} from "./mcp-setup.fixtures";

let admin = true;
vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: () => admin }));
vi.mock("~/lib/mcp-accounts", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-accounts")>()),
  createMcpAccount: vi.fn(),
  listMcpAccounts: vi.fn(),
  getMcpAccountOAuthConfiguration: vi.fn(),
  startMcpAccountOAuth: vi.fn(),
  updateMcpAccount: vi.fn(),
}));
vi.mock("~/lib/mcp-integrations", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-integrations")>()),
  configureMcpIntegration: vi.fn(),
  discoverMcpCapabilities: vi.fn(),
  reviewMcpCapabilities: vi.fn(),
}));
vi.mock("~/lib/mcp-setup", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-setup")>()),
  startMcpSetup: vi.fn(),
  getMcpSetup: vi.fn(),
  resumeMcpSetup: vi.fn(),
  listMcpSetups: vi.fn(),
}));

const configuration = {
  authentication: "token" as const,
  requiredSlots: ["accessToken"],
  sharedAllowed: true,
  definitionDigest: account.definitionDigest,
};
const saved = {
  id: "11111111-1111-4111-8111-111111111111",
  integrationKey: "github-mcp",
  accountId: account.id,
  status: "done" as const,
};
beforeEach(() => {
  vi.resetAllMocks();
  admin = true;
  vi.mocked(listMcpSetups).mockResolvedValue([]);
  vi.mocked(getMcpSetup).mockRejectedValue(new ApiError(404, "Not found"));
  vi.mocked(startMcpSetup).mockImplementation(async (id) => ({ ...saved, id }));
  vi.mocked(resumeMcpSetup).mockImplementation(async (id) => ({ ...saved, id }));
  vi.mocked(listMcpAccounts).mockResolvedValue([account]);
  vi.mocked(discoverMcpCapabilities).mockResolvedValue(access);
});
function mount(overrides: Partial<ComponentProps<typeof McpServerDetail>> = {}) {
  const changed = vi.fn();
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <McpServerDetail
          definition={definition}
          accounts={[account]}
          accountConfiguration={configuration}
          eligibility={eligibility}
          onChanged={changed}
          onRemoved={vi.fn()}
          {...overrides}
        />
      ),
    },
  ]);
  render(<Stub />);
  return changed;
}
async function finish() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Finish connecting" })).toBeEnabled()
  );
  await userEvent.click(screen.getByRole("button", { name: "Finish connecting" }));
}
function noPolicyChain() {
  expect(configureMcpIntegration).not.toHaveBeenCalled();
  expect(discoverMcpCapabilities).not.toHaveBeenCalled();
  expect(reviewMcpCapabilities).not.toHaveBeenCalled();
}

test("an active unfinished account reaches Done with one Finish action and no token or tool picks", async () => {
  const changed = mount();
  await finish();
  expect(await screen.findByRole("status")).toHaveTextContent("Connected");
  expect(startMcpSetup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
    integrationKey: "github-mcp",
    definitionRevision: eligibility.definitionRevision,
    accountId: account.id,
    initializePolicy: true,
  });
  expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: /Approve tools/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Enable integration" })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Discover available access" })
  ).not.toBeInTheDocument();
  expect(createMcpAccount).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
  noPolicyChain();
});

test("post-auth setup failure resumes the same operation without credentials or duplicate accounts", async () => {
  vi.mocked(startMcpSetup).mockImplementation(async (id) => ({
    ...saved,
    id,
    status: "retry",
    error: "setup_failed",
  }));
  mount();
  await finish();
  expect(await screen.findByRole("alert")).toHaveTextContent("Your saved progress is kept");
  expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  const operationId = vi.mocked(startMcpSetup).mock.calls[0]?.[0];
  await finish();
  expect(await screen.findByRole("status")).toHaveTextContent("Connected");
  expect(resumeMcpSetup).toHaveBeenCalledExactlyOnceWith(operationId, undefined);
  expect(startMcpSetup).toHaveBeenCalledOnce();
  expect(createMcpAccount).not.toHaveBeenCalled();
  noPolicyChain();
});

test("saved operation lookup is read-only and a status failure cannot start duplicate setup", async () => {
  vi.mocked(listMcpSetups).mockRejectedValueOnce(new Error("Saved setup unavailable"));
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Saved setup unavailable");
  expect(screen.queryByRole("button", { name: "Finish connecting" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry saved setup" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Finish connecting" })).toBeEnabled()
  );
  expect(listMcpSetups).toHaveBeenCalledWith("github-mcp", account.id);
  expect(startMcpSetup).not.toHaveBeenCalled();
  expect(resumeMcpSetup).not.toHaveBeenCalled();
  noPolicyChain();
});

test.each(["initial", "custom"] as const)(
  "existing %s policy stays untouched and the realistic long tool list is secondary",
  async (reviewPolicy) => {
    mount({
      definition: { ...definition, enabled: true, reviewPolicy, reviewed: access },
      eligibility: { ...eligibility, policy: "preserve", publishedReady: true },
    });
    expect(await screen.findByText("Ready to use")).toBeVisible();
    expect(screen.queryByText("add_issue_comment")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Approve tools/ })).not.toBeInTheDocument();
    expect(startMcpSetup).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Advanced settings"));
    expect(screen.getByText("add_issue_comment")).toBeVisible();
    expect(screen.getByText("update_pull_request_branch")).toBeVisible();
    noPolicyChain();
  }
);

test("custom empty policy is a finished restriction, not an invitation to initialize everything", async () => {
  mount({
    definition: { ...definition, enabled: true, reviewPolicy: "custom" },
    eligibility: { ...eligibility, policy: "preserve", publishedReady: true },
  });
  expect(await screen.findByText(/Existing settings allow no Tools or content/)).toBeVisible();
  expect(screen.queryByText("Ready to use")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Open Chat" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Edit allowed access" }));
  expect(screen.getByText("Allowed Tools and content")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Finish connecting" })).not.toBeInTheDocument();
  expect(startMcpSetup).not.toHaveBeenCalled();
  noPolicyChain();
});

test("shared-only setup requires an exact explicit choice and does not grant Chat consent", async () => {
  const shared = { ...account, id: "shared-account", owner: { scope: "shared" as const } };
  mount({ accounts: [shared] });
  expect(screen.getByRole("button", { name: "Finish connecting" })).toBeDisabled();
  expect(startMcpSetup).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("combobox", { name: "Account to connect" }));
  await userEvent.click(screen.getByRole("option", { name: /Shared/ }));
  await finish();
  expect(startMcpSetup).toHaveBeenCalledWith(expect.any(String), {
    integrationKey: "github-mcp",
    definitionRevision: eligibility.definitionRevision,
    accountId: shared.id,
    initializePolicy: true,
    confirmShared: true,
  });
  noPolicyChain();
});

test("multiple personal accounts are not silently selected", () => {
  mount({ accounts: [account, { ...account, id: "other-personal", label: "Other account" }] });
  expect(screen.getByRole("combobox", { name: "Account to connect" })).toHaveValue("");
  expect(screen.getByRole("button", { name: "Finish connecting" })).toBeDisabled();
  expect(startMcpSetup).not.toHaveBeenCalled();
});

test("ready integrations expose account management instead of a disabled setup step", async () => {
  mount({
    definition: { ...definition, enabled: true, reviewPolicy: "custom", reviewed: access },
    eligibility: { ...eligibility, policy: "preserve", publishedReady: true },
    accounts: [account, { ...account, id: "new-account", createdAt: "2026-09-19T07:00:00Z" }],
  });
  expect(await screen.findByText("Manage your accounts")).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Replace token" })).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Finish connecting" })).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Account to manage" })).toHaveValue("");
  expect(screen.getByText(/Existing Chats keep their selected account/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Add another account" }));
  expect(screen.getByText(/creates a separate connection.*does not replace/i)).toBeVisible();
  expect(startMcpSetup).not.toHaveBeenCalled();
  expect(createMcpAccount).not.toHaveBeenCalled();
});

test("a Secrets account link exposes replacement for that exact account only", async () => {
  const other = { ...account, id: "other-account", createdAt: "2026-09-19T07:00:00Z" };
  vi.mocked(updateMcpAccount).mockResolvedValue({ ...other, revision: 2 });
  mount({
    definition: { ...definition, enabled: true, reviewPolicy: "custom", reviewed: access },
    eligibility: { ...eligibility, policy: "preserve", publishedReady: true },
    accounts: [account, other],
    callbackAccountId: other.id,
  });
  expect(await screen.findByRole("button", { name: "Replace token" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Replace token" }));
  await userEvent.type(screen.getByLabelText("Access token"), "replacement-fixture");
  await userEvent.click(screen.getByRole("button", { name: "Save replacement credentials" }));
  expect(updateMcpAccount).toHaveBeenCalledExactlyOnceWith("github-mcp", other.id, {
    values: { accessToken: "replacement-fixture" },
  });
  expect(startMcpSetup).not.toHaveBeenCalled();
  expect(createMcpAccount).not.toHaveBeenCalled();
});

test("an unavailable account link does not fall back to replacing the sole personal account", async () => {
  mount({
    definition: { ...definition, enabled: true, reviewPolicy: "custom", reviewed: access },
    eligibility: { ...eligibility, policy: "preserve", publishedReady: true },
    callbackAccountId: "unavailable-account",
  });
  expect(await screen.findByText(/selected account is no longer available/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Replace token" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Finish connecting" })).toBeDisabled();
  expect(updateMcpAccount).not.toHaveBeenCalled();
  expect(listMcpSetups).not.toHaveBeenCalled();
});

test("adding an account uses a distinct default name and preserves the old account", async () => {
  mount({
    definition: { ...definition, enabled: true, reviewPolicy: "custom", reviewed: access },
    eligibility: { ...eligibility, policy: "preserve", publishedReady: true },
  });
  await userEvent.click(await screen.findByRole("button", { name: "Add another account" }));
  await userEvent.type(screen.getByLabelText("Access token"), "new-account-fixture");
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(startMcpSetup).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ account: expect.objectContaining({ label: "GitHub account 2" }) })
  );
  expect(updateMcpAccount).not.toHaveBeenCalled();
});
test("current server authority blocks initialization even when cached session claims admin", async () => {
  const changed = mount({ eligibility: { ...eligibility, canConfigure: false } });
  expect(await screen.findByText("An admin needs to finish setup")).toBeVisible();
  expect(startMcpSetup).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Finish connecting" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Every initial Tool call/)).not.toBeInTheDocument();
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  await userEvent.click(screen.getByText("Advanced settings"));
  expect(
    screen.queryByRole("button", { name: "Discover available access" })
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit settings" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Check setup status" }));
  expect(changed).toHaveBeenCalledOnce();
  expect(resumeMcpSetup).not.toHaveBeenCalled();
  noPolicyChain();
});

test.each(["pending", "expired", "stale", "provider-revoked"] as const)(
  "%s token recovery stays on the same saved operation and account",
  async (state) => {
    vi.mocked(startMcpSetup).mockImplementation(async (id) => ({
      ...saved,
      id,
      status: state === "stale" ? "retry" : "needs_credentials",
      error:
        state === "stale"
          ? "account_binding_changed"
          : state === "expired"
            ? "account_expired"
            : state === "provider-revoked"
              ? "reconnect_required"
              : "credentials_required",
    }));
    mount({
      accounts: [
        {
          ...account,
          status: state === "pending" ? "pending" : "active",
          expiresAt: state === "expired" ? "2020-01-01T00:00:00Z" : null,
          definitionDigest: state === "stale" ? "b".repeat(64) : account.definitionDigest,
        },
      ],
    });
    await finish();
    const token = await screen.findByLabelText("Access token");
    expect(token).toHaveAttribute("type", "password");
    await userEvent.type(token, "replacement-fixture-token");
    await userEvent.click(screen.getByRole("button", { name: "Continue connecting" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Connected");
    expect(startMcpSetup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      integrationKey: "github-mcp",
      definitionRevision: eligibility.definitionRevision,
      accountId: account.id,
      initializePolicy: true,
    });
    expect(resumeMcpSetup).toHaveBeenCalledExactlyOnceWith(
      vi.mocked(startMcpSetup).mock.calls[0]?.[0],
      { values: { accessToken: "replacement-fixture-token" } }
    );
    expect(createMcpAccount).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("replacement-fixture-token")).not.toBeInTheDocument();
    noPolicyChain();
  }
);

test.each(["account_binding_changed", "reconnect_required", "capability_changed"] as const)(
  "frozen/current-binding %s never requests credentials or silently rebinds saved consent",
  async (error) => {
    vi.mocked(listMcpSetups).mockResolvedValue([
      {
        ...saved,
        status: "retry",
        error,
      },
    ]);
    mount({ accounts: [{ ...account, revision: 2 }] });
    expect(await screen.findByRole("button", { name: "Use current settings" })).toBeVisible();
    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue connecting" })).not.toBeInTheDocument();
    expect(resumeMcpSetup).not.toHaveBeenCalled();
    expect(startMcpSetup).not.toHaveBeenCalled();
    noPolicyChain();
  }
);

test("authless setup has one explicit Finish action and never invents an account", async () => {
  vi.mocked(startMcpSetup).mockImplementation(async (id) => ({
    id,
    integrationKey: "github-mcp",
    status: "done",
    access: { enabled: true, state: "allowed", tools: 1, resources: 0, prompts: 0 },
  }));
  mount({
    accounts: [],
    accountConfiguration: { authentication: "none", requiredSlots: [], sharedAllowed: false },
  });
  expect(startMcpSetup).not.toHaveBeenCalled();
  await finish();
  expect(startMcpSetup).toHaveBeenCalledWith(expect.any(String), {
    integrationKey: "github-mcp",
    definitionRevision: eligibility.definitionRevision,
    initializePolicy: true,
  });
  expect(createMcpAccount).not.toHaveBeenCalled();
  expect(await screen.findByText(/1 Tool, 0 resources and 0 prompts allowed/)).toBeVisible();
  noPolicyChain();
});

test("account and metadata errors fail closed without guessed fields or a duplicate account form", () => {
  mount({
    accounts: [],
    accountsError: "Accounts unavailable",
    accountConfiguration: undefined,
    configurationError: "Metadata unavailable",
  });
  expect(screen.getAllByRole("alert").map((node) => node.textContent)).toEqual([
    "Accounts unavailable",
    "Metadata unavailable",
  ]);
  expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  expect(startMcpSetup).not.toHaveBeenCalled();
});

test("OAuth return restores saved consent with GET only; explicit Finish resumes the exact operation", async () => {
  const oauthAccount = { ...account, authentication: "oauth" as const };
  vi.mocked(listMcpSetups).mockResolvedValue([{ ...saved, status: "needs_sign_in" }]);
  vi.mocked(listMcpAccounts).mockResolvedValue([oauthAccount]);
  mount({
    accounts: [oauthAccount],
    callbackAccountId: account.id,
    accountConfiguration: { ...configuration, authentication: "oauth", requiredSlots: [] },
  });
  expect(await screen.findByText("Provider sign-in is complete")).toBeVisible();
  expect(listMcpSetups).toHaveBeenCalledWith("github-mcp", account.id);
  expect(resumeMcpSetup).not.toHaveBeenCalled();
  expect(startMcpAccountOAuth).not.toHaveBeenCalled();
  expect(startMcpSetup).not.toHaveBeenCalled();
  await finish();
  expect(resumeMcpSetup).toHaveBeenCalledExactlyOnceWith(saved.id, undefined);
  expect(await screen.findByRole("status")).toHaveTextContent("Connected");
  noPolicyChain();
});

test("registered pending OAuth resumes its exact callback setup without a second account", async () => {
  const oauthAccount = {
    ...account,
    authentication: "oauth" as const,
    status: "pending" as const,
    oauthClient: {
      clientId: "fixture-client",
      tokenEndpointAuthMethod: "client_secret_post" as const,
    },
  };
  vi.mocked(listMcpSetups).mockResolvedValue([{ ...saved, status: "needs_sign_in" }]);
  vi.mocked(listMcpAccounts).mockResolvedValue([oauthAccount]);
  vi.mocked(getMcpAccountOAuthConfiguration).mockResolvedValue({
    callbackUrl: "https://fixture.example/callback",
  });
  mount({
    accounts: [oauthAccount],
    accountConfiguration: { ...configuration, authentication: "oauth", requiredSlots: [] },
  });
  expect(await screen.findByLabelText("OAuth callback URL")).toHaveValue(
    "https://fixture.example/callback"
  );
  expect(startMcpAccountOAuth).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Connect account" }));
  expect(startMcpAccountOAuth).toHaveBeenCalledExactlyOnceWith("github-mcp", account.id);
  expect(createMcpAccount).not.toHaveBeenCalled();
  expect(startMcpSetup).not.toHaveBeenCalled();
});

test("advanced review preserves a custom subset and leaves future additions unselected", async () => {
  const firstTool = access.tools[0];
  if (!firstTool) throw new Error("The fixture needs a reviewed Tool.");
  const existing = { ...firstTool, mutating: false, requiresApproval: false };
  const custom = { tools: [existing], resources: [], prompts: [] };
  const current = {
    ...definition,
    enabled: true,
    reviewPolicy: "custom" as const,
    reviewed: custom,
  };
  vi.mocked(reviewMcpCapabilities).mockResolvedValue(current);
  mount({
    definition: current,
    eligibility: { ...eligibility, policy: "preserve", publishedReady: true },
  });
  await screen.findByText("Ready to use");
  await userEvent.click(screen.getByText("Advanced settings"));
  await userEvent.click(screen.getByRole("button", { name: "Discover available access" }));
  expect(
    await screen.findByRole("checkbox", { name: "Approve tools: add_issue_comment" })
  ).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Approve tools: create_issue" })).not.toBeChecked();
  expect(reviewMcpCapabilities).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Save approved access" }));
  expect(reviewMcpCapabilities).toHaveBeenCalledExactlyOnceWith("github-mcp", custom, {
    accountId: account.id,
  });
  expect(startMcpSetup).not.toHaveBeenCalled();
  expect(configureMcpIntegration).not.toHaveBeenCalled();
});

test("advanced review defaults only the sole current active personal account without discovery", async () => {
  mount({
    accounts: [
      account,
      { ...account, id: "pending", status: "pending" },
      { ...account, id: "stale", definitionDigest: "b".repeat(64) },
      { ...account, id: "expired", expiresAt: "2020-01-01T00:00:00Z" },
    ],
  });
  await userEvent.click(screen.getByText("Advanced settings"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Discover available access" })).toBeEnabled()
  );
  expect(screen.queryByRole("combobox", { name: "Account to review" })).not.toBeInTheDocument();
  expect(screen.getByText(/GitHub account.*for this preview only/)).toBeVisible();
  expect(startMcpSetup).not.toHaveBeenCalled();
  noPolicyChain();
});

test("advanced shared review remains an explicit local choice, not setup or Chat consent", async () => {
  mount({
    definition: { ...definition, enabled: true, reviewPolicy: "custom", reviewed: access },
    accounts: [{ ...account, id: "shared", owner: { scope: "shared" } }],
  });
  await userEvent.click(screen.getByText("Advanced settings"));
  expect(screen.getByRole("button", { name: "Discover available access" })).toBeDisabled();
  await userEvent.click(screen.getByRole("combobox", { name: "Account to review" }));
  await userEvent.click(screen.getByRole("option", { name: /Shared/ }));
  expect(screen.getByRole("button", { name: "Discover available access" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Finish connecting" })).toBeDisabled();
  expect(screen.getByText(/does not authorize content previews or shared Chat use/)).toBeVisible();
  expect(startMcpSetup).not.toHaveBeenCalled();
  noPolicyChain();
});

test("enabled local settings never substitute authoritative publication readiness", async () => {
  mount({
    definition: { ...definition, enabled: true, reviewPolicy: "initial", reviewed: access },
    eligibility: { ...eligibility, policy: "preserve", publishedReady: false },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Finish connecting" })).toBeEnabled()
  );
  expect(screen.queryByText("Ready to use")).not.toBeInTheDocument();
  expect(screen.queryByText(/Every initial Tool call/)).not.toBeInTheDocument();
  expect(startMcpSetup).not.toHaveBeenCalled();
  await finish();
  expect(startMcpSetup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
    integrationKey: "github-mcp",
    accountId: account.id,
    definitionRevision: eligibility.definitionRevision,
    initializePolicy: false,
  });
  noPolicyChain();
});

test.each(["https://api.githubcopilot.com/mcp/", "https://custom.fixture.invalid/mcp"])(
  "server preserve policy wins over an unmarked empty legacy definition at %s",
  async (url) => {
    const legacyDefinition = {
      ...definition,
      server: { ...definition.server, transport: { type: "streamable-http" as const, url } },
    };
    delete legacyDefinition.reviewPolicy;
    mount({
      definition: legacyDefinition,
      eligibility: { ...eligibility, policy: "preserve" },
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Finish connecting" })).toBeEnabled()
    );
    expect(screen.getByText(/Existing settings allow no Tools or content/)).toBeVisible();
    expect(screen.queryByText(/Every initial Tool call/)).not.toBeInTheDocument();
    await finish();
    expect(startMcpSetup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      integrationKey: "github-mcp",
      accountId: account.id,
      definitionRevision: eligibility.definitionRevision,
      initializePolicy: false,
    });
    noPolicyChain();
  }
);

test.each([false, true])(
  "provider-revoked active OAuth uses exact-account sign-in, callback return=%s",
  async (returned) => {
    const oauthAccount = { ...account, authentication: "oauth" as const };
    const reconnect = { ...saved, status: "needs_sign_in" as const, error: "reconnect_required" };
    vi.mocked(listMcpSetups).mockResolvedValue([reconnect]);
    vi.mocked(getMcpSetup).mockResolvedValue(reconnect);
    vi.mocked(resumeMcpSetup).mockResolvedValue(reconnect);
    vi.mocked(listMcpAccounts).mockResolvedValue([oauthAccount]);
    vi.mocked(getMcpAccountOAuthConfiguration).mockResolvedValue({
      callbackUrl: "https://fixture.example/callback",
    });
    mount({
      accounts: [oauthAccount],
      accountConfiguration: { ...configuration, authentication: "oauth", requiredSlots: [] },
      ...(returned
        ? { callbackAccountId: account.id, callbackStatus: "Account sign-in completed." }
        : {}),
    });
    if (returned) {
      expect(await screen.findByText("Provider sign-in is complete")).toBeVisible();
      expect(resumeMcpSetup).not.toHaveBeenCalled();
      await finish();
      expect(resumeMcpSetup).toHaveBeenCalledExactlyOnceWith(saved.id, undefined);
    }
    const signIn = await screen.findByRole("button", { name: "Sign in again" });
    expect(screen.queryByText("Provider sign-in is complete")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Finish connecting" })).not.toBeInTheDocument();
    expect(startMcpAccountOAuth).not.toHaveBeenCalled();
    await userEvent.click(signIn);
    expect(startMcpAccountOAuth).toHaveBeenCalledExactlyOnceWith("github-mcp", account.id);
    expect(createMcpAccount).not.toHaveBeenCalled();
    expect(startMcpSetup).not.toHaveBeenCalled();
    noPolicyChain();
  }
);

test.each(["loading", "error"] as const)(
  "eligibility %s never falls back to apparent ready settings",
  async (state) => {
    const changed = mount({
      definition: { ...definition, enabled: true, reviewPolicy: "custom", reviewed: access },
      eligibility: undefined,
      eligibilityError: state === "error" ? "Setup permissions unavailable" : undefined,
    });
    expect(screen.queryByText("Ready to use")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Finish connecting" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    if (state === "error") {
      expect(screen.getByRole("alert")).toHaveTextContent("Setup permissions unavailable");
      await userEvent.click(screen.getByRole("button", { name: "Reload setup permissions" }));
      expect(changed).toHaveBeenCalledOnce();
    } else expect(screen.getByRole("status")).toHaveTextContent("Checking setup permissions");
    expect(startMcpSetup).not.toHaveBeenCalled();
    expect(resumeMcpSetup).not.toHaveBeenCalled();
    noPolicyChain();
  }
);
