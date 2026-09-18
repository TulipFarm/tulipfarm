import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpAccountSummary } from "@tulipfarm/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { grantMcpAccount, listMcpAccountGrants, revokeMcpAccountGrant } from "~/lib/mcp-accounts";
import { listRoutines } from "~/lib/routines";
import { listTeams } from "~/lib/teams";
import { listUsers } from "~/lib/users";
import { McpAccountGrants } from "./mcp-account-grants";

vi.mock("~/lib/mcp-accounts", () => ({
  grantMcpAccount: vi.fn(),
  listMcpAccountGrants: vi.fn(),
  revokeMcpAccountGrant: vi.fn(),
}));
vi.mock("~/lib/routines", () => ({ listRoutines: vi.fn() }));
vi.mock("~/lib/teams", () => ({ listTeams: vi.fn() }));
vi.mock("~/lib/users", () => ({ listUsers: vi.fn() }));

const account: McpAccountSummary = {
  id: "shared-account",
  integrationKey: "support",
  businessId: "business",
  definitionDigest: "a".repeat(64),
  label: "Support",
  owner: { scope: "shared" },
  authentication: "token",
  status: "active",
  isDefault: false,
  revision: 1,
  expiresAt: null,
  createdAt: "2026-09-18T00:00:00Z",
  updatedAt: "2026-09-18T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listRoutines).mockResolvedValue([]);
  vi.mocked(listTeams).mockResolvedValue({ teams: [] });
  vi.mocked(listUsers).mockResolvedValue([
    {
      id: "user-1",
      name: "Muskan Vijayvargiya",
      email: "muskan@example.com",
      status: "active",
      role: "member",
    },
  ]);
  vi.mocked(listMcpAccountGrants).mockResolvedValue([]);
});

function mount() {
  const Stub = createRemixStub([
    { path: "/", Component: () => <McpAccountGrants account={account} /> },
  ]);
  render(<Stub />);
}

test("shows server-calculated stale approval even when the account revision is unchanged", async () => {
  vi.mocked(listMcpAccountGrants).mockResolvedValue([
    {
      businessId: "business",
      accountId: account.id,
      accountRevision: 1,
      subject: { kind: "routine", id: "daily-review", configurationDigest: "b".repeat(64) },
      grantedBy: "admin",
      grantedAt: account.createdAt,
      status: "stale",
    },
  ]);
  mount();
  expect(
    await screen.findByText("Account or configuration changed; fresh approval required.")
  ).toBeInTheDocument();
  expect(grantMcpAccount).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Approve current configuration" }));
  expect(grantMcpAccount).toHaveBeenCalledWith("support", "shared-account", {
    kind: "routine",
    id: "daily-review",
  });
});

test("sends only the exact selected user and leaves configuration calculation to the API", async () => {
  mount();
  await userEvent.click(await screen.findByRole("combobox", { name: "Grant recipient" }));
  await userEvent.click(await screen.findByRole("option", { name: /Muskan Vijayvargiya/ }));
  await userEvent.click(screen.getByRole("button", { name: "Grant shared account use" }));
  expect(grantMcpAccount).toHaveBeenCalledWith("support", "shared-account", {
    kind: "user",
    id: "user-1",
  });
  expect(revokeMcpAccountGrant).not.toHaveBeenCalled();
});
