import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpAccountSummary } from "@tulipfarm/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { createMcpAccount, startMcpAccountOAuth } from "~/lib/mcp-accounts";
import { McpAccountForm } from "./mcp-account-form";

let admin = false;
vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: () => admin }));
vi.mock("~/lib/mcp-accounts", () => ({ createMcpAccount: vi.fn(), startMcpAccountOAuth: vi.fn() }));
beforeEach(() => {
  admin = false;
  vi.clearAllMocks();
});
const account: McpAccountSummary = {
  id: "account",
  integrationKey: "support",
  businessId: "business",
  definitionDigest: "a".repeat(64),
  label: "My account",
  owner: { scope: "personal", principalId: "owner" },
  authentication: "token",
  status: "active",
  isDefault: false,
  revision: 1,
  expiresAt: null,
  createdAt: "2026-09-18T00:00:00Z",
  updatedAt: "2026-09-18T00:00:00Z",
};

test("personal token account uses masked inputs and clears the secret after persistence", async () => {
  vi.mocked(createMcpAccount).mockResolvedValue(account);
  const changed = vi.fn();
  render(
    <McpAccountForm
      integrationKey="support"
      authentication="token"
      requiredSlots={["accessToken"]}
      sharedAllowed
      onChanged={changed}
    />
  );
  await userEvent.type(screen.getByLabelText("Account label"), "My account");
  const token = screen.getByLabelText("Access token");
  expect(token).toHaveAttribute("type", "password");
  await userEvent.type(token, "test-secret-value");
  await userEvent.click(screen.getByRole("button", { name: "Connect account" }));
  expect(createMcpAccount).toHaveBeenCalledWith("support", {
    label: "My account",
    scope: "personal",
    authentication: "token",
    isDefault: false,
    values: { accessToken: "test-secret-value" },
  });
  expect(token).toHaveValue("");
  expect(screen.queryByText("test-secret-value")).not.toBeInTheDocument();
  expect(changed).toHaveBeenCalledOnce();
  expect(screen.queryByRole("combobox", { name: "Account ownership" })).not.toBeInTheDocument();
});

test("OAuth creates the exact pending account before a backend sign-in redirect", async () => {
  vi.mocked(createMcpAccount).mockResolvedValue({
    ...account,
    authentication: "oauth",
    status: "pending",
  });
  vi.mocked(startMcpAccountOAuth).mockResolvedValue(undefined);
  render(
    <McpAccountForm
      integrationKey="support"
      authentication="oauth"
      requiredSlots={[]}
      sharedAllowed={false}
      onChanged={vi.fn()}
    />
  );
  await userEvent.type(screen.getByLabelText("Account label"), "My account");
  await userEvent.click(screen.getByRole("button", { name: "Connect with browser sign-in" }));
  expect(createMcpAccount).toHaveBeenCalledWith("support", {
    label: "My account",
    scope: "personal",
    authentication: "oauth",
  });
  expect(startMcpAccountOAuth).toHaveBeenCalledWith("support", "account");
});

test("a rejected credential never produces a connected notice", async () => {
  vi.mocked(createMcpAccount).mockRejectedValue(new Error("Credential verification failed."));
  render(
    <McpAccountForm
      integrationKey="support"
      authentication="token"
      requiredSlots={["accessToken"]}
      sharedAllowed={false}
      onChanged={vi.fn()}
    />
  );
  await userEvent.type(screen.getByLabelText("Account label"), "My account");
  await userEvent.type(screen.getByLabelText("Access token"), "invalid");
  await userEvent.click(screen.getByRole("button", { name: "Connect account" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Credential verification failed.");
  expect(screen.queryByText("Account connected.")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Access token")).toHaveValue("");
});

test("a registered OAuth app sends its secret only in account creation and clears it afterward", async () => {
  vi.mocked(createMcpAccount).mockResolvedValue({
    ...account,
    authentication: "oauth",
    status: "pending",
  });
  vi.mocked(startMcpAccountOAuth).mockResolvedValue(undefined);
  render(
    <McpAccountForm
      integrationKey="support"
      authentication="oauth"
      requiredSlots={[]}
      sharedAllowed={false}
      onChanged={vi.fn()}
    />
  );
  await userEvent.type(screen.getByLabelText("Account label"), "My account");
  await userEvent.click(screen.getByText("Use an existing OAuth app"));
  await userEvent.type(await screen.findByLabelText("OAuth client ID"), "registered-client");
  await userEvent.click(screen.getByRole("combobox", { name: "Token endpoint authentication" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "Client secret in Authorization header" })
  );
  const secret = screen.getByLabelText("OAuth client secret");
  expect(secret).toHaveAttribute("type", "password");
  await userEvent.type(secret, "fake-client-secret");
  await userEvent.click(screen.getByRole("button", { name: "Save OAuth account" }));
  expect(createMcpAccount).toHaveBeenCalledWith("support", {
    label: "My account",
    scope: "personal",
    authentication: "oauth",
    oauthClient: {
      clientId: "registered-client",
      clientSecret: "fake-client-secret",
      tokenEndpointAuthMethod: "client_secret_basic",
    },
  });
  expect(startMcpAccountOAuth).not.toHaveBeenCalled();
  expect(await screen.findByRole("status")).toHaveTextContent("Register the OAuth callback URL");
  expect(secret).toHaveValue("");
  expect(window.location.search).not.toContain("fake-client-secret");
});
