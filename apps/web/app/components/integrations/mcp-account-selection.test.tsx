import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpAccountSelectionRequest, McpAccountSummary } from "@tulipfarm/schema";
import { expect, test, vi } from "vitest";
import { McpAccountSelection } from "./mcp-account-selection";

const account: McpAccountSummary = {
  id: "shared-account",
  businessId: "business",
  integrationKey: "support",
  label: "Support shared",
  owner: { scope: "shared" },
  status: "active",
  authentication: "token",
  isDefault: false,
  revision: 1,
  definitionDigest: "a".repeat(64),
  expiresAt: null,
  createdAt: "2026-09-18T00:00:00Z",
  updatedAt: "2026-09-18T00:00:00Z",
};

type SelectAccount = (input: McpAccountSelectionRequest) => Promise<void>;

function mount(
  onSelect: SelectAccount,
  accounts: McpAccountSummary[] = [account],
  selection: McpAccountSummary | null = null
) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <McpAccountSelection
          integrationKey="support"
          integrationLabel="Support"
          accounts={accounts}
          selection={selection}
          onSelect={onSelect}
        />
      ),
    },
  ]);
  render(<Stub />);
}

test("requires explicit shared-use confirmation before saving a Chat account", async () => {
  const save = vi.fn<SelectAccount>().mockResolvedValue(undefined);
  mount(save);
  await userEvent.click(await screen.findByRole("combobox", { name: "Support account" }));
  await userEvent.click(await screen.findByRole("option", { name: /Support shared/ }));
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Confirm shared account" }));
  expect(save).toHaveBeenCalledWith({ accountId: "shared-account", confirmShared: true });
});

test("keeps multiple personal accounts distinct and never auto-selects a default", async () => {
  const save = vi.fn<SelectAccount>().mockResolvedValue(undefined);
  const personal: McpAccountSummary = {
    ...account,
    owner: { scope: "personal", principalId: "user" },
    label: "My workspace",
    id: "personal-one",
    isDefault: true,
  };
  mount(save, [personal, { ...personal, id: "personal-two", isDefault: false }]);
  await userEvent.click(await screen.findByRole("combobox", { name: "Support account" }));
  expect(await screen.findByRole("option", { name: /personal-one/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("option", { name: /personal-two/ }));
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Use this account" }));
  expect(save).toHaveBeenCalledWith({ accountId: "personal-two", confirmShared: false });
});

test("keeps selection failures visible instead of reporting local success", async () => {
  const save = vi
    .fn<SelectAccount>()
    .mockRejectedValue(new Error("Shared account permission was revoked."));
  mount(save);
  await userEvent.click(await screen.findByRole("combobox", { name: "Support account" }));
  await userEvent.click(await screen.findByRole("option", { name: /Support shared/ }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm shared account" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Shared account permission was revoked."
  );
  expect(screen.getByText("No account selected for this Chat.")).toBeInTheDocument();
});
