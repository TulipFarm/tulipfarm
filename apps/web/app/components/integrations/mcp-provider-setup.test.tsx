import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import {
  createMcpAccount,
  getMcpAccountOAuthConfiguration,
  listMcpAccounts,
  startMcpAccountOAuth,
} from "~/lib/mcp-accounts";
import {
  configureMcpIntegration,
  discoverMcpCapabilities,
  getMcpCatalogSetup,
  type McpCatalogEntry,
  type McpCatalogSetup,
  reviewMcpCapabilities,
} from "~/lib/mcp-integrations";
import { getMcpSetup, resumeMcpSetup, startMcpSetup } from "~/lib/mcp-setup";
import { McpProviderSetup } from "./mcp-provider-setup";
import {
  githubAccountFixture as account,
  githubDefinitionFixture as definition,
} from "./mcp-setup.fixtures";

vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: () => true }));
vi.mock("~/lib/mcp-accounts", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-accounts")>()),
  createMcpAccount: vi.fn(),
  startMcpAccountOAuth: vi.fn(),
  listMcpAccounts: vi.fn(),
  getMcpAccountOAuthConfiguration: vi.fn(),
}));
vi.mock("~/lib/mcp-integrations", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-integrations")>()),
  configureMcpIntegration: vi.fn(),
  getMcpCatalogSetup: vi.fn(),
  discoverMcpCapabilities: vi.fn(),
  reviewMcpCapabilities: vi.fn(),
}));
vi.mock("~/lib/mcp-setup", async (original) => ({
  ...(await original<typeof import("~/lib/mcp-setup")>()),
  startMcpSetup: vi.fn(),
  resumeMcpSetup: vi.fn(),
  getMcpSetup: vi.fn(),
}));
const entry: McpCatalogEntry = {
  id: "github",
  name: "GitHub",
  publisher: "GitHub",
  url: "https://api.githubcopilot.com/mcp/",
  publisherEvidence: "https://github.com/github/github-mcp-server",
  authentication: ["token", "oauth"],
  setup: [],
  limitations: [],
  knowledgeSync: "excluded",
};
const metadata: McpCatalogSetup = {
  server: definition.server,
  configuration: {
    authentication: "token",
    requiredSlots: ["trustedToken"],
    sharedAllowed: false,
    definitionDigest: account.definitionDigest,
  },
  requiresOAuthApp: true,
};
const saved = {
  id: "11111111-1111-4111-8111-111111111111",
  integrationKey: "github-mcp",
  accountId: account.id,
  status: "done" as const,
  access: { enabled: true, state: "allowed" as const, tools: 1, resources: 0, prompts: 0 },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getMcpCatalogSetup).mockResolvedValue(metadata);
  vi.mocked(startMcpSetup).mockImplementation(async (id) => ({ ...saved, id }));
  vi.mocked(resumeMcpSetup).mockImplementation(async (id) => ({ ...saved, id }));
  vi.mocked(getMcpSetup).mockRejectedValue(new ApiError(404, "Not found"));
  vi.mocked(listMcpAccounts).mockResolvedValue([account]);
  vi.mocked(getMcpAccountOAuthConfiguration).mockResolvedValue({
    callbackUrl: "https://fixture.example/callback",
  });
});
function mount(provider = entry) {
  const changed = vi.fn();
  const done = vi.fn();
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => <McpProviderSetup entry={provider} onChanged={changed} onDone={done} />,
    },
  ]);
  return {
    ...render(<Stub />),
    changed,
    done,
  };
}
async function connect() {
  await userEvent.type(await screen.findByLabelText("trustedToken"), "fixture-token");
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
}
function noLegacyWrites() {
  expect(createMcpAccount).not.toHaveBeenCalled();
  expect(configureMcpIntegration).not.toHaveBeenCalled();
  expect(discoverMcpCapabilities).not.toHaveBeenCalled();
  expect(reviewMcpCapabilities).not.toHaveBeenCalled();
}

test("opening and cancelling only reads trusted metadata and never creates configuration or accounts", async () => {
  const view = mount();
  expect(await screen.findByLabelText("trustedToken")).toHaveAttribute("type", "password");
  expect(screen.getByLabelText("Account name")).not.toBeVisible();
  expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  view.unmount();
  expect(startMcpSetup).not.toHaveBeenCalled();
  expect(resumeMcpSetup).not.toHaveBeenCalled();
  expect(startMcpAccountOAuth).not.toHaveBeenCalled();
  noLegacyWrites();
});

test("empty provider discovery offers access recovery instead of suggesting Chat", async () => {
  vi.mocked(startMcpSetup).mockImplementation(async (id) => ({
    ...saved,
    id,
    access: { enabled: true, state: "discovered_empty", tools: 0, resources: 0, prompts: 0 },
  }));
  mount();
  await connect();
  expect(await screen.findByRole("status")).toHaveTextContent("access needs attention");
  expect(screen.getByText(/The provider returned no Tools or content/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Review integration access" })).toHaveAttribute(
    "href",
    "/integrations/github-mcp"
  );
  expect(screen.queryByRole("link", { name: "Open Chat" })).not.toBeInTheDocument();
  noLegacyWrites();
});

test("one token submission reaches Done without discovery buttons, tool choices, or a separate enable action", async () => {
  const { done, changed } = mount();
  await screen.findByLabelText("trustedToken");
  expect(screen.getByText(/Every initial Tool call still requires approval/)).toBeVisible();
  await connect();
  expect(await screen.findByRole("status")).toHaveTextContent("Connected");
  expect(startMcpSetup).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
    providerId: "github",
    authentication: "token",
    account: { label: "GitHub account", scope: "personal", authentication: "token" },
    values: { trustedToken: "fixture-token" },
    initializePolicy: true,
  });
  expect(screen.queryByRole("checkbox", { name: /Approve/ })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Discover|Enable integration|Save approved/ })
  ).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue("fixture-token")).not.toBeInTheDocument();
  expect(changed).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(done).toHaveBeenCalledOnce();
  noLegacyWrites();
});

test("an in-flight Connect shows honest progress rather than an early connected state", async () => {
  let complete: ((value: typeof saved) => void) | undefined;
  vi.mocked(startMcpSetup).mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    })
  );
  mount();
  await connect();
  expect(screen.getByRole("status")).toHaveTextContent("Connecting...");
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  complete?.(saved);
  expect(await screen.findByRole("button", { name: "Done" })).toBeVisible();
});

test("failed post-auth setup resumes the saved operation, not the credential form", async () => {
  vi.mocked(startMcpSetup).mockImplementation(async (id) => ({
    ...saved,
    id,
    status: "retry",
    error: "setup_failed",
  }));
  mount();
  await connect();
  expect(await screen.findByRole("alert")).toHaveTextContent("Your saved progress is kept");
  expect(screen.queryByLabelText("trustedToken")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Finish connecting" }));
  expect(resumeMcpSetup).toHaveBeenCalledExactlyOnceWith(
    vi.mocked(startMcpSetup).mock.calls[0]?.[0],
    undefined
  );
  expect(await screen.findByRole("status")).toHaveTextContent("Connected");
  expect(startMcpSetup).toHaveBeenCalledOnce();
  noLegacyWrites();
});

test("a lost response reads persisted status before offering exact-operation resume", async () => {
  vi.mocked(startMcpSetup).mockRejectedValue(new ApiError(0, "Connection interrupted"));
  vi.mocked(getMcpSetup).mockImplementation(async (id) => ({ ...saved, id, status: "retry" }));
  const { changed } = mount();
  await connect();
  expect(await screen.findByRole("button", { name: "Finish connecting" })).toBeVisible();
  expect(screen.queryByLabelText("trustedToken")).not.toBeInTheDocument();
  expect(changed).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole("button", { name: "Finish connecting" }));
  expect(startMcpSetup).toHaveBeenCalledOnce();
  expect(resumeMcpSetup).toHaveBeenCalledExactlyOnceWith(
    vi.mocked(startMcpSetup).mock.calls[0]?.[0],
    undefined
  );
  noLegacyWrites();
});

test("an unknown result stays unresolved until a read confirms success", async () => {
  vi.mocked(startMcpSetup).mockRejectedValue(new ApiError(0, "Offline"));
  vi.mocked(getMcpSetup)
    .mockRejectedValueOnce(new ApiError(0, "Still offline"))
    .mockResolvedValueOnce(saved);
  const { changed } = mount();
  await connect();
  expect(await screen.findByRole("button", { name: "Check connection status" })).toBeVisible();
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("trustedToken")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Check connection status" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Connected");
  expect(startMcpSetup).toHaveBeenCalledOnce();
  expect(resumeMcpSetup).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
});

test("a pre-persistence failure keeps the same operation ID on explicit resubmission", async () => {
  vi.mocked(startMcpSetup).mockRejectedValueOnce(new ApiError(500, "Setup unavailable"));
  mount();
  await connect();
  expect(await screen.findByLabelText("trustedToken")).toHaveValue("");
  await connect();
  expect(await screen.findByRole("status")).toHaveTextContent("Connected");
  expect(vi.mocked(startMcpSetup).mock.calls[1]?.[0]).toBe(
    vi.mocked(startMcpSetup).mock.calls[0]?.[0]
  );
});

test("only advertised sign-in methods are offered and selection performs no write", async () => {
  mount();
  await screen.findByLabelText("trustedToken");
  await userEvent.click(screen.getByRole("combobox", { name: "Sign-in method" }));
  expect(screen.getByRole("option", { name: "Access token" })).toBeVisible();
  expect(screen.getByRole("option", { name: "Sign in with provider" })).toBeVisible();
  expect(screen.queryByRole("option", { name: "No sign-in" })).not.toBeInTheDocument();
  expect(startMcpSetup).not.toHaveBeenCalled();
});

test("registered OAuth saves its intent and exact callback account before explicit provider sign-in", async () => {
  vi.mocked(getMcpCatalogSetup).mockResolvedValue({
    ...metadata,
    configuration: { ...metadata.configuration, authentication: "oauth", requiredSlots: [] },
  });
  vi.mocked(startMcpSetup).mockImplementation(async (id) => ({
    ...saved,
    id,
    status: "needs_sign_in",
    error: "sign_in_required",
  }));
  vi.mocked(listMcpAccounts).mockResolvedValue([
    {
      ...account,
      authentication: "oauth",
      status: "pending",
      oauthClient: { clientId: "fixture-client", tokenEndpointAuthMethod: "client_secret_post" },
    },
  ]);
  mount({ ...entry, authentication: ["oauth"] });
  await userEvent.type(await screen.findByLabelText("OAuth client ID"), "fixture-client");
  await userEvent.type(screen.getByLabelText("OAuth client secret"), "fixture-client-secret");
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByLabelText("OAuth callback URL")).toHaveValue(
    "https://fixture.example/callback"
  );
  expect(startMcpSetup).toHaveBeenCalledWith(expect.any(String), {
    providerId: "github",
    authentication: "oauth",
    initializePolicy: true,
    account: {
      label: "GitHub account",
      scope: "personal",
      authentication: "oauth",
      oauthClient: { clientId: "fixture-client", tokenEndpointAuthMethod: "client_secret_post" },
    },
    clientSecret: "fixture-client-secret",
  });
  expect(startMcpAccountOAuth).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("OAuth client secret")).not.toBeInTheDocument();
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Connect account" }));
  expect(startMcpAccountOAuth).toHaveBeenCalledExactlyOnceWith("github-mcp", account.id);
  noLegacyWrites();
});

test("provider-managed OAuth starts only after explicit Connect created the saved intent", async () => {
  vi.mocked(getMcpCatalogSetup).mockResolvedValue({
    ...metadata,
    requiresOAuthApp: false,
    configuration: { ...metadata.configuration, authentication: "oauth", requiredSlots: [] },
  });
  vi.mocked(startMcpSetup).mockImplementation(async (id) => ({
    ...saved,
    id,
    status: "needs_sign_in",
  }));
  vi.mocked(listMcpAccounts).mockResolvedValue([
    { ...account, authentication: "oauth", status: "pending" },
  ]);
  mount({ ...entry, authentication: ["oauth"] });
  await screen.findByRole("button", { name: "Connect" });
  expect(startMcpAccountOAuth).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(startMcpAccountOAuth).toHaveBeenCalledExactlyOnceWith("github-mcp", account.id)
  );
  expect(vi.mocked(startMcpSetup).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(startMcpAccountOAuth).mock.invocationCallOrder[0] ?? 0
  );
});

test("failed trusted metadata never exposes guessed credential fields", async () => {
  vi.mocked(getMcpCatalogSetup).mockRejectedValueOnce(new Error("Metadata unavailable"));
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Metadata unavailable");
  expect(screen.queryByLabelText("trustedToken")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry account setup" }));
  expect(await screen.findByLabelText("trustedToken")).toBeVisible();
  expect(startMcpSetup).not.toHaveBeenCalled();
});

test("closing an in-flight OAuth setup never starts a later hidden sign-in or refresh", async () => {
  let complete: ((value: Awaited<ReturnType<typeof startMcpSetup>>) => void) | undefined;
  vi.mocked(getMcpCatalogSetup).mockResolvedValue({
    ...metadata,
    requiresOAuthApp: false,
    configuration: { ...metadata.configuration, authentication: "oauth", requiredSlots: [] },
  });
  vi.mocked(startMcpSetup).mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    })
  );
  const view = mount({ ...entry, authentication: ["oauth"] });
  await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
  view.unmount();
  await act(async () => complete?.({ ...saved, status: "needs_sign_in" }));
  expect(startMcpSetup).toHaveBeenCalledOnce();
  expect(startMcpAccountOAuth).not.toHaveBeenCalled();
  expect(getMcpSetup).not.toHaveBeenCalled();
  expect(view.changed).not.toHaveBeenCalled();
});

import { createRemixStub } from "@remix-run/testing";
