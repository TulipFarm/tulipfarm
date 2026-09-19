import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpAccountSummary } from "@tulipfarm/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { copyText } from "~/lib/clipboard";
import {
  createMcpAccount,
  getMcpAccountOAuthConfiguration,
  revokeMcpAccount,
  startMcpAccountOAuth,
  updateMcpAccount,
} from "~/lib/mcp-accounts";
import { getMcpKnowledge } from "~/lib/mcp-knowledge";
import { McpAccountRow } from "./mcp-account-row";

vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: () => false }));
vi.mock("~/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("~/lib/mcp-knowledge", () => ({ getMcpKnowledge: vi.fn() }));
vi.mock("~/lib/mcp-accounts", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-accounts")>()),
  getMcpAccountOAuthConfiguration: vi.fn(),
  revokeMcpAccount: vi.fn(),
  startMcpAccountOAuth: vi.fn(),
  updateMcpAccount: vi.fn(),
  createMcpAccount: vi.fn(),
}));

const callbackUrl =
  "https://operator.example/api/v1/integrations/support/accounts/account/oauth/callback";
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getMcpAccountOAuthConfiguration).mockResolvedValue({ callbackUrl });
  vi.mocked(startMcpAccountOAuth).mockResolvedValue(undefined);
  vi.mocked(copyText).mockResolvedValue(true);
});

const account: McpAccountSummary = {
  id: "account",
  businessId: "business",
  integrationKey: "support",
  definitionDigest: "a".repeat(64),
  label: "My account",
  owner: { scope: "personal", principalId: "user" },
  authentication: "oauth",
  oauthClient: {
    clientId: "registered-client-id",
    tokenEndpointAuthMethod: "client_secret_basic",
  },
  status: "action_required",
  isDefault: false,
  revision: 1,
  expiresAt: null,
  createdAt: "2026-09-18T00:00:00Z",
  updatedAt: "2026-09-18T00:00:00Z",
};

function mount(currentAccount = account, definitionDigest?: string) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <ul>
          <McpAccountRow
            account={currentAccount}
            definitionDigest={definitionDigest}
            requiredSlots={["accessToken"]}
            onChanged={vi.fn()}
          />
        </ul>
      ),
    },
  ]);
  render(<Stub />);
}

test("a stale OAuth account requires new registration instead of reusing old app credentials", () => {
  mount({ ...account, status: "active" }, "b".repeat(64));
  expect(screen.getByText("Settings changed")).toBeVisible();
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("OAuth callback URL")).not.toBeInTheDocument();
  expect(screen.getByText(/Connect a new account for the current sign-in settings/)).toBeVisible();
  expect(getMcpAccountOAuthConfiguration).not.toHaveBeenCalled();
});

test("registered OAuth account metadata shows only its public client identity and actionable status", async () => {
  mount();
  expect(screen.getByText(/OAuth app: registered-client-id/)).not.toBeVisible();
  await userEvent.click(screen.getByText("Account options"));
  await userEvent.click(screen.getByText("Technical details"));
  expect(screen.getByText(/OAuth app: registered-client-id/)).toHaveTextContent(
    "Registered confidential client"
  );
  expect(screen.getByText("Action required")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  expect(await screen.findByLabelText("OAuth callback URL")).toHaveValue(callbackUrl);
  expect(screen.queryByLabelText("OAuth client secret")).not.toBeInTheDocument();
});

test("a pending account exposes the server callback for copying before explicit sign-in", async () => {
  mount({ ...account, status: "pending" });
  expect(screen.getByText("Finish sign-in")).toBeVisible();
  expect(screen.queryByText("Verification incomplete")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Connect account" })).toBeDisabled();
  const field = await screen.findByLabelText("OAuth callback URL");
  expect(field).toHaveAttribute("readonly");
  expect(field).toHaveValue(callbackUrl);
  expect(getMcpAccountOAuthConfiguration).toHaveBeenCalledWith("support", "account");
  expect(startMcpAccountOAuth).not.toHaveBeenCalled();
  expect(screen.getByText("Finish setting up your provider app")).toBeVisible();
  expect(
    screen.getByText("Register it in your provider's OAuth app settings and save your changes.")
  ).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Copy callback URL" }));
  expect(copyText).toHaveBeenCalledWith(callbackUrl);
  expect(await screen.findByRole("status")).toHaveTextContent("Callback URL copied.");
  await userEvent.click(screen.getByRole("button", { name: "Connect account" }));
  expect(startMcpAccountOAuth).toHaveBeenCalledWith("support", "account");
});

test("provider-managed sign-in keeps callback details optional and never signs in automatically", async () => {
  mount({ ...account, oauthClient: undefined, status: "pending" });
  const callback = await screen.findByLabelText("OAuth callback URL");
  expect(callback).not.toBeVisible();
  expect(screen.queryByText("Finish setting up your provider app")).not.toBeInTheDocument();
  expect(startMcpAccountOAuth).not.toHaveBeenCalled();
  await userEvent.click(screen.getByText("Advanced sign-in details"));
  expect(callback).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Connect account" }));
  expect(startMcpAccountOAuth).toHaveBeenCalledExactlyOnceWith("support", "account");
});

test("personal accounts expose optional Knowledge setup without opening shared access controls", async () => {
  vi.mocked(getMcpKnowledge).mockResolvedValue({
    eligibility: {
      supported: true,
      reason: null,
      sourceKind: "github-file",
      visibility: "personal",
    },
    selection: null,
  });

  mount({ ...account, authentication: "token", oauthClient: undefined, status: "active" });
  expect(screen.getByText("Personal · only you")).toBeVisible();
  expect(screen.getByText("Connected")).toBeVisible();
  expect(screen.queryByText("Manage shared access")).not.toBeInTheDocument();
  expect(getMcpKnowledge).not.toHaveBeenCalled();
  await userEvent.click(screen.getByText("Account options"));
  await userEvent.click(screen.getByText("Manage Knowledge sync"));
  expect(await screen.findByRole("button", { name: "Save Knowledge sources" })).toBeVisible();
  expect(getMcpKnowledge).toHaveBeenCalledExactlyOnceWith("support", "account");
});

test("account management is optional and disconnect still requires explicit confirmation", async () => {
  vi.mocked(revokeMcpAccount).mockResolvedValue(undefined);
  mount({ ...account, authentication: "token", oauthClient: undefined, status: "active" });
  expect(screen.getByRole("button", { name: "Disconnect account" })).not.toBeVisible();
  await userEvent.click(screen.getByText("Account options"));
  await userEvent.click(screen.getByRole("button", { name: "Disconnect account" }));
  expect(revokeMcpAccount).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
  expect(revokeMcpAccount).toHaveBeenCalledExactlyOnceWith("support", "account");
});

test("connected token accounts expose same-account replacement without opening options", async () => {
  const current = {
    ...account,
    authentication: "token" as const,
    oauthClient: undefined,
    status: "active" as const,
  };
  vi.mocked(updateMcpAccount).mockResolvedValue({ ...current, revision: 2 });
  mount(current);
  expect(screen.getByRole("button", { name: "Replace token" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Replace token" }));
  expect(screen.getByText(/does not create another account/i)).toBeVisible();
  await userEvent.type(screen.getByLabelText("Access token"), "replacement-fixture");
  await userEvent.click(screen.getByRole("button", { name: "Save replacement credentials" }));
  expect(updateMcpAccount).toHaveBeenCalledExactlyOnceWith("support", "account", {
    values: { accessToken: "replacement-fixture" },
  });
  expect(createMcpAccount).not.toHaveBeenCalled();
});

test("members cannot manage someone else's shared account or grant access", () => {
  mount({
    ...account,
    authentication: "token",
    oauthClient: undefined,
    owner: { scope: "shared" },
    status: "active",
  });
  expect(screen.queryByText("Account options")).not.toBeInTheDocument();
  expect(screen.queryByText("Manage shared access")).not.toBeInTheDocument();
  expect(screen.queryByText("Manage Knowledge sync")).not.toBeInTheDocument();
  expect(revokeMcpAccount).not.toHaveBeenCalled();
});

test("pending tokens expose same-account verification, not OAuth or duplicate creation", async () => {
  const pendingToken = {
    ...account,
    authentication: "token" as const,
    oauthClient: undefined,
    status: "pending" as const,
  };
  vi.mocked(updateMcpAccount).mockResolvedValue({ ...pendingToken, status: "active" });
  mount(pendingToken);
  expect(screen.getByText("Verification incomplete")).toBeVisible();
  expect(
    screen.getByText("Your account was saved, but token verification did not finish.")
  ).toBeVisible();
  expect(screen.queryByText("Finish sign-in")).not.toBeInTheDocument();
  expect(screen.queryByText("Manage Knowledge sync")).not.toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Verify token" }));
  expect(screen.getByLabelText("Access token")).toHaveValue("");
  expect(screen.getByLabelText("Access token")).toHaveAttribute("type", "password");
  await userEvent.type(screen.getByLabelText("Access token"), "fake-reentered-token");
  await userEvent.click(screen.getByRole("button", { name: "Verify this account" }));
  expect(updateMcpAccount).toHaveBeenCalledExactlyOnceWith("support", "account", {
    values: { accessToken: "fake-reentered-token" },
  });
  expect(createMcpAccount).not.toHaveBeenCalled();
  expect(startMcpAccountOAuth).not.toHaveBeenCalled();
  expect(screen.queryByDisplayValue("fake-reentered-token")).not.toBeInTheDocument();
});

test("failed token recovery remains on the same account and clears entered credentials", async () => {
  vi.mocked(updateMcpAccount).mockRejectedValue(new Error("Verification service unavailable."));
  mount({ ...account, authentication: "token", oauthClient: undefined, status: "pending" });
  await userEvent.click(screen.getByRole("button", { name: "Verify token" }));
  await userEvent.type(screen.getByLabelText("Access token"), "fake-reentered-token");
  await userEvent.click(screen.getByRole("button", { name: "Verify this account" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Verification service unavailable.");
  expect(screen.getByLabelText("Access token")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Verify this account" })).toBeEnabled();
  expect(screen.getByText("Verification incomplete")).toBeVisible();
  expect(createMcpAccount).not.toHaveBeenCalled();
});

test("failed callback lookup blocks sign-in and retries without guessing a URL", async () => {
  vi.mocked(getMcpAccountOAuthConfiguration)
    .mockRejectedValueOnce(new Error("Callback configuration unavailable."))
    .mockResolvedValueOnce({ callbackUrl });
  mount({ ...account, status: "pending" });
  expect(await screen.findByRole("alert")).toHaveTextContent("Callback configuration unavailable.");
  expect(screen.queryByLabelText("OAuth callback URL")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Connect account" })).toBeDisabled();
  expect(startMcpAccountOAuth).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Retry callback URL" }));
  expect(await screen.findByLabelText("OAuth callback URL")).toHaveValue(callbackUrl);
});

test("copy failures do not claim the callback was copied", async () => {
  vi.mocked(copyText).mockResolvedValue(false);
  mount();
  await screen.findByLabelText("OAuth callback URL");
  await userEvent.click(screen.getByRole("button", { name: "Copy callback URL" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Select and copy it manually.");
  expect(screen.queryByText("Callback URL copied.")).not.toBeInTheDocument();
});

test("a changed server directs new account creation instead of reusing stored OAuth credentials", async () => {
  vi.mocked(startMcpAccountOAuth).mockRejectedValue(
    new ApiError(409, "Server changed.", undefined, "definition_changed")
  );
  mount();
  await screen.findByLabelText("OAuth callback URL");
  await userEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Add a new account for the new settings"
  );
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeDisabled();
  expect(screen.queryByLabelText("OAuth callback URL")).not.toBeInTheDocument();
});
