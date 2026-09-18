import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpAccountSummary } from "@tulipfarm/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { copyText } from "~/lib/clipboard";
import { getMcpAccountOAuthConfiguration, startMcpAccountOAuth } from "~/lib/mcp-accounts";
import { McpAccountRow } from "./mcp-account-row";

vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: () => false }));
vi.mock("~/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("~/lib/mcp-accounts", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-accounts")>()),
  getMcpAccountOAuthConfiguration: vi.fn(),
  startMcpAccountOAuth: vi.fn(),
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

function mount(currentAccount = account) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <ul>
          <McpAccountRow account={currentAccount} onChanged={vi.fn()} />
        </ul>
      ),
    },
  ]);
  render(<Stub />);
}

test("registered OAuth account metadata shows only its public client identity and actionable status", async () => {
  mount();
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
  expect(screen.getByRole("button", { name: "Connect account" })).toBeDisabled();
  const field = await screen.findByLabelText("OAuth callback URL");
  expect(field).toHaveAttribute("readonly");
  expect(field).toHaveValue(callbackUrl);
  expect(getMcpAccountOAuthConfiguration).toHaveBeenCalledWith("support", "account");
  expect(startMcpAccountOAuth).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Copy callback URL" }));
  expect(copyText).toHaveBeenCalledWith(callbackUrl);
  expect(await screen.findByRole("status")).toHaveTextContent("Callback URL copied.");
  await userEvent.click(screen.getByRole("button", { name: "Connect account" }));
  expect(startMcpAccountOAuth).toHaveBeenCalledWith("support", "account");
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
  expect(await screen.findByRole("alert")).toHaveTextContent("Create a new account");
  expect(screen.getByRole("button", { name: "Sign in again" })).toBeDisabled();
  expect(screen.queryByLabelText("OAuth callback URL")).not.toBeInTheDocument();
});
