import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { createMcpAccount } from "~/lib/mcp-accounts";
import {
  configureMcpIntegration,
  discoverMcpCapabilities,
  reviewMcpCapabilities,
} from "~/lib/mcp-integrations";
import { getMcpSetup, listMcpSetups, resumeMcpSetup, startMcpSetup } from "~/lib/mcp-setup";
import { McpServerDetail } from "./mcp-server-detail";
import {
  githubAccountFixture as account,
  githubAccessFixture,
  githubDefinitionFixture,
  githubEligibilityFixture,
} from "./mcp-setup.fixtures";

vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: () => true }));
vi.mock("~/lib/mcp-setup", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-setup")>()),
  startMcpSetup: vi.fn(),
  getMcpSetup: vi.fn(),
  listMcpSetups: vi.fn(),
  resumeMcpSetup: vi.fn(),
}));
vi.mock("~/lib/mcp-accounts", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-accounts")>()),
  createMcpAccount: vi.fn(),
}));
vi.mock("~/lib/mcp-integrations", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-integrations")>()),
  configureMcpIntegration: vi.fn(),
  discoverMcpCapabilities: vi.fn(),
  reviewMcpCapabilities: vi.fn(),
}));

const legacy = { ...githubDefinitionFixture };
delete legacy.reviewPolicy;
const eligibility = {
  ...githubEligibilityFixture,
  policy: "preserve" as const,
  canUseStandardAccess: true,
};
const standard = "Use standard access and connect";
const preserve = "Keep existing access and connect";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listMcpSetups).mockResolvedValue([]);
  vi.mocked(getMcpSetup).mockRejectedValue(new ApiError(404, "Not found"));
  vi.mocked(startMcpSetup).mockImplementation(async (id) => ({
    id,
    integrationKey: "github-mcp",
    accountId: account.id,
    status: "done",
  }));
});

function mount(overrides: Partial<ComponentProps<typeof McpServerDetail>> = {}) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <McpServerDetail
          definition={legacy}
          accounts={[account]}
          eligibility={eligibility}
          accountConfiguration={{
            authentication: "token",
            requiredSlots: ["accessToken"],
            sharedAllowed: false,
            definitionDigest: account.definitionDigest,
          }}
          onChanged={vi.fn()}
          onRemoved={vi.fn()}
          {...overrides}
        />
      ),
    },
  ]);
  return render(<Stub />);
}

function noLegacyChain() {
  expect(createMcpAccount).not.toHaveBeenCalled();
  expect(configureMcpIntegration).not.toHaveBeenCalled();
  expect(discoverMcpCapabilities).not.toHaveBeenCalled();
  expect(reviewMcpCapabilities).not.toHaveBeenCalled();
}

test("legacy standard access is one explicit revision-bound action using the existing account", async () => {
  mount();
  const button = await screen.findByRole("button", { name: standard });
  expect(screen.getByText(/Replace the old empty access policy/)).toBeVisible();
  expect(startMcpSetup).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  await userEvent.click(button);
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(startMcpSetup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
    integrationKey: "github-mcp",
    accountId: account.id,
    definitionRevision: eligibility.definitionRevision,
    initializePolicy: true,
    legacyEmptyPolicyConsent: "use_standard_access",
  });
  expect(screen.queryByRole("checkbox", { name: /Approve tools/ })).not.toBeInTheDocument();
  noLegacyChain();
});

test("ordinary Connect still preserves the empty policy when standard access is available", async () => {
  mount();
  await userEvent.click(await screen.findByRole("button", { name: preserve }));
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(startMcpSetup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
    integrationKey: "github-mcp",
    accountId: account.id,
    definitionRevision: eligibility.definitionRevision,
    initializePolicy: false,
  });
  noLegacyChain();
});

test.each(["custom-empty", "nonempty", "uninitialized", "member"] as const)(
  "%s cannot choose legacy standard access",
  async (kind) => {
    const ready = kind === "custom-empty" || kind === "nonempty";
    mount({
      definition:
        kind === "uninitialized"
          ? githubDefinitionFixture
          : {
              ...legacy,
              enabled: ready,
              ...(kind === "custom-empty" ? { reviewPolicy: "custom" as const } : {}),
              ...(kind === "nonempty" ? { reviewed: githubAccessFixture } : {}),
            },
      eligibility: {
        ...eligibility,
        canUseStandardAccess: kind === "member",
        canConfigure: kind !== "member",
        publishedReady: ready,
        policy: kind === "uninitialized" ? "initialize" : "preserve",
      },
    });
    if (kind === "custom-empty") await screen.findByText("Account connected — no access allowed");
    else if (ready) await screen.findByText("Ready to use");
    else if (kind === "member") await screen.findByText("An admin needs to finish setup");
    else await screen.findByRole("button", { name: "Finish connecting" });
    expect(screen.queryByRole("button", { name: standard })).not.toBeInTheDocument();
    expect(startMcpSetup).not.toHaveBeenCalled();
    noLegacyChain();
  }
);

test("a published legacy-empty policy still offers explicit same-account standard access", async () => {
  mount({
    definition: { ...legacy, enabled: true },
    eligibility: { ...eligibility, publishedReady: true },
  });
  expect(await screen.findByText("Account connected — no access allowed")).toBeVisible();
  expect(screen.queryByRole("link", { name: "Open Chat" })).not.toBeInTheDocument();
  expect(startMcpSetup).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: standard }));
  expect(startMcpSetup).toHaveBeenCalledWith(expect.any(String), {
    integrationKey: "github-mcp",
    accountId: account.id,
    definitionRevision: eligibility.definitionRevision,
    initializePolicy: true,
    legacyEmptyPolicyConsent: "use_standard_access",
  });
  noLegacyChain();
});

test("credential submission can explicitly choose standard access without a separate policy step", async () => {
  mount({ accounts: [] });
  await userEvent.type(screen.getByLabelText("Access token"), "fixture-token");
  await userEvent.click(screen.getByRole("button", { name: standard }));
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(startMcpSetup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
    integrationKey: "github-mcp",
    definitionRevision: eligibility.definitionRevision,
    account: { label: "GitHub account", scope: "personal", authentication: "token" },
    values: { accessToken: "fixture-token" },
    initializePolicy: true,
    legacyEmptyPolicyConsent: "use_standard_access",
  });
  expect(screen.queryByDisplayValue("fixture-token")).not.toBeInTheDocument();
  noLegacyChain();
});

test("Enter submits preservation rather than opting into replacing the old empty policy", async () => {
  mount({ accounts: [] });
  await userEvent.type(screen.getByLabelText("Access token"), "fixture-token{Enter}");
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(vi.mocked(startMcpSetup).mock.calls[0]?.[1]).toMatchObject({ initializePolicy: false });
  expect(vi.mocked(startMcpSetup).mock.calls[0]?.[1]).not.toHaveProperty(
    "legacyEmptyPolicyConsent"
  );
  noLegacyChain();
});

test("a guarded old journal never receives amended consent; explicit standard access starts fresh", async () => {
  const oldId = "11111111-1111-4111-8111-111111111111";
  vi.mocked(listMcpSetups).mockResolvedValue([
    {
      id: oldId,
      integrationKey: "github-mcp",
      accountId: account.id,
      status: "retry",
      error: "capability_changed",
    },
  ]);
  mount();
  expect(await screen.findByRole("button", { name: "Use current settings" })).toBeVisible();
  expect(screen.queryByRole("button", { name: standard })).not.toBeInTheDocument();
  expect(startMcpSetup).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Use current settings" }));
  await userEvent.click(await screen.findByRole("button", { name: standard }));
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(vi.mocked(startMcpSetup).mock.calls[0]?.[0]).not.toBe(oldId);
  expect(vi.mocked(startMcpSetup).mock.calls[0]?.[1]).toMatchObject({
    accountId: account.id,
    legacyEmptyPolicyConsent: "use_standard_access",
    definitionRevision: eligibility.definitionRevision,
  });
  expect(resumeMcpSetup).not.toHaveBeenCalled();
  noLegacyChain();
});

test("retrying the same explicit standard consent preserves its operation UUID", async () => {
  vi.mocked(startMcpSetup).mockRejectedValueOnce(new ApiError(500, "Unavailable"));
  mount();
  await userEvent.click(await screen.findByRole("button", { name: standard }));
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: standard }));
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(vi.mocked(startMcpSetup).mock.calls[1]?.[0]).toBe(
    vi.mocked(startMcpSetup).mock.calls[0]?.[0]
  );
  noLegacyChain();
});

test("changing an unsuccessful preservation choice to standard consent uses a new operation", async () => {
  vi.mocked(startMcpSetup).mockRejectedValueOnce(new ApiError(500, "Unavailable"));
  mount();
  await userEvent.click(await screen.findByRole("button", { name: preserve }));
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: standard }));
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(vi.mocked(startMcpSetup).mock.calls[1]?.[0]).not.toBe(
    vi.mocked(startMcpSetup).mock.calls[0]?.[0]
  );
  expect(vi.mocked(startMcpSetup).mock.calls[1]?.[1]).toMatchObject({
    accountId: account.id,
    legacyEmptyPolicyConsent: "use_standard_access",
  });
  noLegacyChain();
});
