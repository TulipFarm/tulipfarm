import { readFile } from "node:fs/promises";
import { useLocation, useNavigate } from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseOimManifest } from "@tulipfarm/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";

let admin = true;

vi.mock("~/lib/use-session-user", () => ({
  useSessionUser: () => ({
    id: "u1",
    email: "a@b.dev",
    name: null,
    role: admin ? "admin" : "member",
  }),
  useIsAdmin: () => admin,
}));

beforeEach(() => {
  admin = true;
  vi.clearAllMocks();
  vi.mocked(getInstalledOimRelease).mockResolvedValue(null);
});

vi.mock("~/lib/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/integrations")>()),
  createOimConnection: vi.fn(),
  deleteIntegration: vi.fn(),
  disconnectIntegration: vi.fn(),
  disconnectGitHubInstallation: vi.fn(),
  disconnectPersonalIntegration: vi.fn(),
  getIntegration: vi.fn(),
  getInstalledOimRelease: vi.fn(),
  getOimConnectionSetup: vi.fn(),
  getOimReleaseUninstallStatus: vi.fn(),
  listOimConnections: vi.fn(),
  revokeOimConnection: vi.fn(),
  setOimAutoPatchPreference: vi.fn(),
  uninstallOimRelease: vi.fn(),
  updateIntegration: vi.fn(),
}));

import type {
  IntegrationDetail,
  OimConnectionSetup,
  OimConnectionSummary,
} from "~/lib/integrations";
import {
  createOimConnection,
  deleteIntegration,
  disconnectIntegration,
  getInstalledOimRelease,
  getIntegration,
  getOimConnectionSetup,
  getOimReleaseUninstallStatus,
  listOimConnections,
  revokeOimConnection,
  setOimAutoPatchPreference,
  uninstallOimRelease,
  updateIntegration,
} from "~/lib/integrations";
import IntegrationDetailPage, { clientLoader } from "./_app.integrations.$name";

function IntegrationDetailWithLocation() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <IntegrationDetailPage />
      <span data-testid="location-search">{location.search}</span>
      <button type="button" onClick={() => navigate("/integrations/other")}>
        Switch test integration
      </button>
    </>
  );
}

function detail(over: Partial<IntegrationDetail> = {}): IntegrationDetail {
  return {
    name: "github",
    title: "GitHub",
    type: "none",
    installed: true,
    status: "disconnected",
    connected: false,
    auth: [],
    grants: [],
    manifest: {},
    ...over,
  };
}

function renderDetail(
  integration: IntegrationDetail,
  oimConnections?: OimConnectionSummary[],
  initialEntry = "/integrations/github",
  oimConnectionSetup?: OimConnectionSetup,
  oimConnectionId?: string
) {
  const Stub = createRemixStub([
    {
      path: "/integrations/:name",
      Component: IntegrationDetailWithLocation,
      loader: () => ({
        integration,
        routesError: undefined,
        githubInstallations: [],
        usesOimConnections: oimConnections !== undefined || oimConnectionSetup !== undefined,
        oimConnections,
        oimConnectionsError: undefined,
        oimConnectionSetup,
        oimConnectionSetupError: undefined,
        oimConnectionId,
      }),
    },
    { path: "/integrations", Component: () => <p>catalog</p> },
  ]);
  render(<Stub initialEntries={[initialEntry]} />);
}

function renderDetailWithClientLoader(initialEntry: string) {
  const Stub = createRemixStub([
    {
      path: "/integrations/:name",
      Component: IntegrationDetailWithLocation,
      loader: (args) => clientLoader(args as never),
    },
  ]);
  render(<Stub initialEntries={[initialEntry]} />);
}

function createdConnection() {
  return {
    connectionId: "connection-1",
    verification: { status: "not_required" as const },
  };
}

test("starts Linear key setup from the shipped verified manifest", async () => {
  const manifest = parseOimManifest(await readFile("../../integrations/linear/oim.yml", "utf8"));
  expect(manifest.auth?.verification?.evidence.assurance).toBe("identified");
  const fields = manifest.auth?.steps.find((step) => step.type === "fields");
  if (fields?.type !== "fields") throw new Error("Linear must declare key setup");
  vi.mocked(getIntegration).mockResolvedValue(
    detail({
      name: manifest.metadata.id,
      title: manifest.metadata.name,
      type: "oim",
    })
  );
  vi.mocked(listOimConnections).mockResolvedValue([]);
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    integration: { id: manifest.metadata.id, majorVersion: 1 },
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [
      {
        id: fields.id,
        title: fields.title,
        fields: fields.fields.map((field) => ({
          id: field.id,
          label: field.label,
          input: field.input,
          required: field.required === true,
          secret: field.target.type === "credential",
        })),
      },
    ],
    initialAuthorizationSteps: [],
  });
  vi.mocked(createOimConnection).mockResolvedValue({
    connectionId: "linear-connection",
    verification: { status: "verified" },
  });
  const user = userEvent.setup();
  renderDetailWithClientLoader("/integrations/linear");
  await user.type(await screen.findByLabelText("Connection name"), "My Linear");
  const key = screen.getByLabelText("API key");
  expect(key).toHaveAttribute("type", "password");
  await user.type(key, "offline-linear-key");
  await user.click(screen.getByRole("button", { name: "Create Connection" }));
  await waitFor(() =>
    expect(createOimConnection).toHaveBeenCalledWith("linear", {
      label: "My Linear",
      ownerScope: "personal",
      values: { api_key: "offline-linear-key" },
    })
  );
  expect(await screen.findByRole("heading", { name: "Connection added" })).toBeInTheDocument();
});

test("leads with the brand name but keeps the slug visible", async () => {
  renderDetail(detail({ name: "github", title: "GitHub" }));
  const heading = await screen.findByRole("heading", { level: 1, name: "GitHub" });
  const header = heading.closest("header") as HTMLElement;
  expect(within(header).getByText("github")).toBeInTheDocument();
  expect(screen.getAllByText("github")).toHaveLength(1);
});

test("falls back to the slug as the heading when nothing curated a title", async () => {
  renderDetail(detail({ name: "acme-crm", title: undefined }));
  expect(await screen.findByRole("heading", { level: 1, name: "acme-crm" })).toBeInTheDocument();
});

test("never shows the egress type, which reads 'none' and means nothing to an operator", async () => {
  renderDetail(detail({ type: "none" }));
  await screen.findByRole("heading", { level: 1 });
  expect(screen.queryByText("none")).not.toBeInTheDocument();
  expect(screen.queryByText(/transport/i)).not.toBeInTheDocument();
});

test("lists the authority being granted, in the provider's own words", async () => {
  renderDetail(
    detail({
      grants: [
        { label: "contents", access: "write", description: "Read files and push commits." },
        { label: "metadata", access: "read", description: "Read repository names." },
      ],
    })
  );

  const heading = await screen.findByText(/access you grant/i);
  const section = heading.closest("section") as HTMLElement;
  expect(within(section).getByText("contents")).toBeInTheDocument();
  expect(within(section).getByText("write")).toBeInTheDocument();
  expect(within(section).getByText("Read files and push commits.")).toBeInTheDocument();
});

test("hides the access section entirely when an integration asks for no authority", async () => {
  renderDetail(detail({ grants: [] }));
  await screen.findByRole("heading", { level: 1 });
  expect(screen.queryByText(/access you grant/i)).not.toBeInTheDocument();
});

test("tells a connected operator what is reachable now, not what will be asked for", async () => {
  renderDetail(detail({ connected: true, status: "connected", grants: [{ label: "chat:write" }] }));
  expect(await screen.findByText(/what this integration can reach today/i)).toBeInTheDocument();
  expect(screen.queryByText(/what connecting asks the provider for/i)).not.toBeInTheDocument();
});

test("shows what agents can do when the manifest says so", async () => {
  renderDetail(detail({ capabilities: ["Triage issues", "Merge pull requests"] }));
  expect(await screen.findByText("Triage issues")).toBeInTheDocument();
  expect(screen.getByText("Merge pull requests")).toBeInTheDocument();
});

test("offers connected Slack Knowledge setup without claiming automatic indexing", async () => {
  renderDetail(
    detail({
      name: "slack",
      title: "Slack",
      connected: true,
      status: "connected",
      setupGuide: "# Slack setup",
      knowledge: {
        mode: "user_configured",
        automatic_indexing: false,
        source_tools: ["slack_channel_list", "slack_message_history"],
        write_tools: ["create_knowledge_page"],
      },
    })
  );

  expect(await screen.findByRole("heading", { name: "Knowledge" })).toBeInTheDocument();
  expect(screen.getByText(/nothing is indexed automatically/i)).toBeInTheDocument();
  expect(screen.getByText(/private channels and DMs are refused/i)).toBeInTheDocument();
  const link = screen.getByRole("link", { name: "Set up in Chat" });
  expect(link).toHaveAttribute("href", expect.stringContaining("/?draft="));
  expect(decodeURIComponent(link.getAttribute("href") ?? "")).toMatch(
    /slack_message_history.*create_knowledge_page/i
  );
  expect(screen.getByRole("button", { name: "View setup guide" })).toBeInTheDocument();
});

test("shows connection state as a badge in the header", async () => {
  renderDetail(detail({ connected: true, status: "connected" }));
  expect(await screen.findByText("Connected")).toBeInTheDocument();
});

test("offers Disconnect only once connected", async () => {
  renderDetail(detail({ connected: false }));
  await screen.findByRole("heading", { level: 1 });
  expect(screen.queryByRole("button", { name: /disconnect/i })).not.toBeInTheDocument();
});

test("disconnects through the API without removing the integration", async () => {
  const user = userEvent.setup();
  renderDetail(detail({ connected: true, status: "connected" }));

  await user.click(await screen.findByRole("button", { name: /^disconnect$/i }));
  expect(disconnectIntegration).toHaveBeenCalledWith("github");
  expect(deleteIntegration).not.toHaveBeenCalled();
});

test("uses exact Connection revoke instead of legacy disconnect for OIM", async () => {
  const user = userEvent.setup();
  vi.mocked(revokeOimConnection).mockResolvedValue({ status: "revoked" });
  renderDetail(detail({ connected: true, status: "connected" }), [
    {
      id: "connection-1",
      integration: { id: "github", majorVersion: 2 },
      label: "Engineering",
      owner: { scope: "organization" },
      status: "active",
      isDefault: true,
      configuration: {},
      availableCredentialSlots: ["access_token"],
      disconnectPending: false,
      health: { status: "healthy", checkedAt: "2026-09-13T10:00:00.000Z" },
      expiresAt: null,
    },
  ]);

  await user.click(await screen.findByRole("button", { name: "Disconnect Engineering" }));
  await user.click(screen.getByRole("button", { name: "Disconnect Connection" }));

  expect(revokeOimConnection).toHaveBeenCalledWith("github", "connection-1");
  expect(disconnectIntegration).not.toHaveBeenCalled();
});

test("keeps an OIM callback failure visible after clearing the callback URL", async () => {
  renderDetail(
    detail({ name: "github", title: "GitHub" }),
    [],
    "/integrations/github?status=error&reason=invalid_state"
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This setup link expired or was already used. Start the step again."
  );
  expect(screen.getByTestId("location-search")).toHaveTextContent("");
});

test("keeps the exact callback Connection through a successful two-step redirect", async () => {
  const callbackSetup: OimConnectionSetup = {
    integration: { id: "github", majorVersion: 2 },
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [
      { id: "install", title: "Install app", type: "install" },
      { id: "webhook", title: "Register webhook", type: "webhook" },
    ],
    pendingAuthorizationStepIds: ["install", "webhook"],
  };
  renderDetail(
    detail({ name: "github", title: "GitHub" }),
    [],
    "/integrations/github?connection=connection-1&status=ok&tab=setup",
    callbackSetup,
    "connection-1"
  );

  expect(
    await screen.findByRole("button", { name: "Continue with Install app" })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Continue with Register webhook" })
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "?connection=connection-1&tab=setup"
    )
  );
});

test("keeps a known Connection after a callback error", async () => {
  const callbackSetup: OimConnectionSetup = {
    integration: { id: "github", majorVersion: 2 },
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [{ id: "install", title: "Install app", type: "install" }],
    pendingAuthorizationStepIds: ["install"],
  };
  renderDetail(
    detail({ name: "github", title: "GitHub" }),
    [],
    "/integrations/github?connection=connection-1&status=error&reason=invalid_state",
    callbackSetup,
    "connection-1"
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This setup link expired or was already used. Start the step again."
  );
  expect(screen.getByRole("button", { name: "Continue with Install app" })).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByTestId("location-search")).toHaveTextContent("?connection=connection-1")
  );
});

test("validates the callback Connection through the exact setup endpoint", async () => {
  vi.mocked(getIntegration).mockResolvedValue(detail({ name: "acme-v2", type: "oim" }));
  vi.mocked(listOimConnections).mockResolvedValue([]);
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    integration: { id: "acme", majorVersion: 2 },
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [],
    pendingAuthorizationStepIds: [],
  });

  const result = await clientLoader({
    params: { name: "acme-v2" },
    request: new Request(
      "https://app.example.test/integrations/acme-v2?connection=connection-1&status=ok"
    ),
    context: {},
  } as never);

  expect(getOimConnectionSetup).toHaveBeenCalledWith("acme-v2", "connection-1");
  expect(result.oimConnectionId).toBe("connection-1");
});

test("rejects a callback Connection that the exact setup endpoint does not authorize", async () => {
  const rejection = new ApiError(404, "Connection not found");
  vi.mocked(getIntegration).mockResolvedValue(detail({ name: "acme-v2", type: "oim" }));
  vi.mocked(listOimConnections).mockResolvedValue([]);
  vi.mocked(getOimConnectionSetup).mockRejectedValue(rejection);

  await expect(
    clientLoader({
      params: { name: "acme-v2" },
      request: new Request(
        "https://app.example.test/integrations/acme-v2?connection=other-owner-or-major"
      ),
      context: {},
    } as never)
  ).rejects.toBe(rejection);

  expect(getOimConnectionSetup).toHaveBeenCalledWith("acme-v2", "other-owner-or-major");
});

test("never sends the Connection list read for a non-OIM Integration", async () => {
  vi.mocked(getIntegration).mockResolvedValue(detail({ name: "slack", type: "slack" }));
  vi.mocked(listOimConnections).mockRejectedValue(new ApiError(404, "integration_not_found"));

  const result = await clientLoader({
    params: { name: "slack" },
    request: new Request("https://app.example.test/integrations/slack"),
    context: {},
  } as never);

  expect(listOimConnections).not.toHaveBeenCalled();
  expect(getOimConnectionSetup).not.toHaveBeenCalled();
  expect(result.usesOimConnections).toBe(false);
  expect(result.oimConnections).toBeUndefined();
  expect(result.oimConnectionsError).toBeUndefined();
});

test("keeps exact setup usable when the Connection list is temporarily unavailable", async () => {
  vi.mocked(getIntegration).mockResolvedValue(
    detail({ name: "acme-v2", type: "oim", title: "Acme" })
  );
  vi.mocked(listOimConnections).mockRejectedValue(
    new ApiError(503, "Connections are temporarily unavailable.")
  );
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    integration: { id: "acme", majorVersion: 2 },
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [{ id: "account", title: "Authorize account", type: "oauth2" }],
    pendingAuthorizationStepIds: ["account"],
  });

  renderDetailWithClientLoader("/integrations/acme-v2?connection=connection-1");

  expect(
    await screen.findByRole("button", { name: "Continue with Authorize account" })
  ).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Connections are temporarily unavailable.");
  expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
});

test("renders ID-bound retries when both OIM reads are temporarily unavailable", async () => {
  vi.mocked(getIntegration).mockResolvedValue(
    detail({ name: "acme-v2", type: "oim", title: "Acme" })
  );
  vi.mocked(listOimConnections).mockRejectedValue(
    new ApiError(503, "Connections are temporarily unavailable.")
  );
  vi.mocked(getOimConnectionSetup).mockRejectedValue(
    new ApiError(503, "Setup is temporarily unavailable.")
  );

  renderDetailWithClientLoader("/integrations/acme-v2?connection=connection-1");

  expect(await screen.findByRole("button", { name: "Retry setup" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry Connections" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
  expect(screen.queryByText("No Connections are available.")).not.toBeInTheDocument();
  expect(screen.getByTestId("location-search")).toHaveTextContent("?connection=connection-1");
  expect(getOimConnectionSetup).toHaveBeenCalledTimes(1);
  expect(getOimConnectionSetup).toHaveBeenCalledWith("acme-v2", "connection-1");
});

test("does not require a generic setup lookup after an exact transient failure", async () => {
  vi.mocked(getIntegration).mockResolvedValue(
    detail({ name: "acme-v2", type: "oim", title: "Acme" })
  );
  vi.mocked(listOimConnections).mockResolvedValue([]);
  vi.mocked(getOimConnectionSetup).mockRejectedValue(
    new ApiError(503, "Setup is temporarily unavailable.")
  );

  renderDetailWithClientLoader("/integrations/acme-v2?connection=connection-1");

  expect(await screen.findByRole("button", { name: "Retry setup" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
  expect(getOimConnectionSetup).toHaveBeenCalledTimes(1);
  expect(getOimConnectionSetup).not.toHaveBeenCalledWith("acme-v2", undefined);
});

test("renders an exact Connection verification repair after reload", async () => {
  vi.mocked(getIntegration).mockResolvedValue(
    detail({ name: "acme-v2", type: "oim", title: "Acme" })
  );
  vi.mocked(listOimConnections).mockResolvedValue([
    {
      id: "connection-1",
      integration: { id: "acme", majorVersion: 2 },
      label: "Support",
      owner: { scope: "personal", principalKind: "user", principalId: "u1" },
      status: "active",
      isDefault: true,
      configuration: {},
      availableCredentialSlots: ["api_token"],
      disconnectPending: false,
      health: { status: "action_required", checkedAt: "2026-09-13T10:00:00.000Z" },
      expiresAt: null,
    },
  ]);
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    integration: { id: "acme", majorVersion: 2 },
    connectionHealth: "action_required",
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [],
    pendingAuthorizationStepIds: [],
  });

  renderDetailWithClientLoader("/integrations/acme-v2?connection=connection-1");

  const heading = await screen.findByRole("heading", { name: "Connection needs verification" });
  expect(screen.getByRole("button", { name: "Retry verification" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("verification needs another try");
  await waitFor(() => expect(heading).toHaveFocus());
});

test("recovers missing generic setup with a valid scope, announcement, and focus", async () => {
  const user = userEvent.setup();
  const organizationSetup: OimConnectionSetup = {
    integration: { id: "acme", majorVersion: 2 },
    allowedOwnerScopes: ["organization"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [],
    pendingAuthorizationStepIds: [],
  };
  let genericAttempts = 0;
  vi.mocked(getIntegration).mockResolvedValue(
    detail({ name: "acme-v2", type: "oim", title: "Acme" })
  );
  vi.mocked(listOimConnections).mockResolvedValue([]);
  vi.mocked(getOimConnectionSetup).mockImplementation((_name, connectionId) => {
    if (connectionId !== undefined) return Promise.resolve(organizationSetup);
    genericAttempts += 1;
    return genericAttempts === 1
      ? Promise.reject(new ApiError(503, "Setup is temporarily unavailable."))
      : Promise.resolve(organizationSetup);
  });
  vi.mocked(createOimConnection).mockResolvedValue(createdConnection());

  renderDetailWithClientLoader("/integrations/acme-v2");

  await user.click(await screen.findByRole("button", { name: "Retry setup" }));

  const heading = await screen.findByRole("heading", { name: "Add Connection" });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Connection setup loaded. Add Connection details."
  );
  await waitFor(() => expect(heading).toHaveFocus());
  expect(screen.getByLabelText("Owner")).toHaveValue("Business");

  await user.type(screen.getByLabelText("Connection name"), "Support");
  await user.click(screen.getByRole("button", { name: "Create Connection" }));

  expect(createOimConnection).toHaveBeenCalledWith("acme-v2", {
    label: "Support",
    ownerScope: "organization",
    values: {},
  });
  expect(createOimConnection).toHaveBeenCalledTimes(1);
});

test("preserves local exact setup when route revalidation cannot reload it", async () => {
  const user = userEvent.setup();
  const completedSetup: OimConnectionSetup = {
    integration: { id: "acme", majorVersion: 2 },
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [],
    pendingAuthorizationStepIds: [],
  };
  let exactSetupAttempts = 0;
  vi.mocked(getIntegration).mockResolvedValue(
    detail({ name: "acme-v2", type: "oim", title: "Acme" })
  );
  vi.mocked(listOimConnections).mockResolvedValue([]);
  vi.mocked(getOimConnectionSetup).mockImplementation((_name, connectionId) => {
    if (connectionId === undefined) return Promise.resolve(completedSetup);
    exactSetupAttempts += 1;
    return exactSetupAttempts === 1
      ? Promise.resolve(completedSetup)
      : Promise.reject(new ApiError(503, "Setup is temporarily unavailable."));
  });
  vi.mocked(createOimConnection).mockResolvedValue(createdConnection());

  renderDetailWithClientLoader("/integrations/acme-v2");

  await user.type(await screen.findByLabelText("Connection name"), "Support");
  await user.click(screen.getByRole("button", { name: "Create Connection" }));

  const completion = await screen.findByRole("heading", { name: "Connection added" });
  await waitFor(() => expect(exactSetupAttempts).toBeGreaterThan(1));
  expect(screen.getByTestId("location-search")).toHaveTextContent("?connection=connection-1");
  expect(screen.queryByRole("button", { name: "Retry setup" })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Connection added.");
  await waitFor(() => expect(completion).toHaveFocus());
  expect(createOimConnection).toHaveBeenCalledTimes(1);
});

test.each([401, 403, 404])("fails closed when exact setup returns %i", async (status) => {
  const rejection = new ApiError(status, "Exact setup is not authorized.");
  vi.mocked(getIntegration).mockResolvedValue(detail({ name: "acme-v2", type: "oim" }));
  vi.mocked(listOimConnections).mockResolvedValue([]);
  vi.mocked(getOimConnectionSetup).mockRejectedValue(rejection);

  await expect(
    clientLoader({
      params: { name: "acme-v2" },
      request: new Request("https://app.example.test/integrations/acme-v2?connection=connection-1"),
      context: {},
    } as never)
  ).rejects.toBe(rejection);
});

test.each([401, 403, 404])("fails closed when Connection listing returns %i", async (status) => {
  const rejection = new ApiError(status, "Connection listing is not authorized.");
  vi.mocked(getIntegration).mockResolvedValue(detail({ name: "acme-v2", type: "oim" }));
  vi.mocked(listOimConnections).mockRejectedValue(rejection);

  await expect(
    clientLoader({
      params: { name: "acme-v2" },
      request: new Request("https://app.example.test/integrations/acme-v2?connection=connection-1"),
      context: {},
    } as never)
  ).rejects.toBe(rejection);
  expect(getOimConnectionSetup).not.toHaveBeenCalled();
});

test("keeps creation focus and status through the Connection query revalidation", async () => {
  const user = userEvent.setup();
  const completedSetup: OimConnectionSetup = {
    integration: { id: "acme", majorVersion: 2 },
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [],
    pendingAuthorizationStepIds: [],
  };
  let exactSetupAttempts = 0;
  vi.mocked(getIntegration).mockResolvedValue(
    detail({ name: "acme-v2", type: "oim", title: "Acme" })
  );
  vi.mocked(listOimConnections).mockResolvedValue([]);
  vi.mocked(getOimConnectionSetup).mockImplementation((_name, connectionId) => {
    if (connectionId === undefined) return Promise.resolve(completedSetup);
    exactSetupAttempts += 1;
    if (exactSetupAttempts <= 2) {
      return Promise.reject(new ApiError(503, "Setup is temporarily unavailable."));
    }
    return Promise.resolve(completedSetup);
  });

  vi.mocked(createOimConnection).mockResolvedValue(createdConnection());
  renderDetailWithClientLoader("/integrations/acme-v2");
  await user.type(await screen.findByLabelText("Connection name"), "Support");
  await user.click(screen.getByRole("button", { name: "Create Connection" }));
  expect(await screen.findByRole("button", { name: "Retry setup" })).toBeInTheDocument();
  expect(createOimConnection).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Retry setup" }));
  const completion = await screen.findByRole("heading", { name: "Connection added" });
  await waitFor(() =>
    expect(screen.getByTestId("location-search")).toHaveTextContent("?connection=connection-1")
  );
  await waitFor(() => expect(vi.mocked(listOimConnections).mock.calls.length).toBeGreaterThan(1));
  expect(screen.getByRole("status")).toHaveTextContent("Connection added.");
  await waitFor(() => expect(completion).toHaveFocus());
  expect(createOimConnection).toHaveBeenCalledTimes(1);
});

test("resumes the listed exact Connection and resets to a blank add-another form", async () => {
  const user = userEvent.setup();
  const setup: OimConnectionSetup = {
    integration: { id: "acme", majorVersion: 2 },
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [
      {
        id: "fields",
        title: "Credentials",
        fields: [
          { id: "token", label: "API token", input: "password", required: true, secret: true },
        ],
      },
    ],
    initialAuthorizationSteps: [{ id: "oauth", title: "Authorize", type: "oauth2" }],
    pendingAuthorizationStepIds: ["oauth"],
  };
  vi.mocked(getIntegration).mockResolvedValue(detail({ name: "acme-v2", type: "oim" }));
  vi.mocked(listOimConnections).mockResolvedValue([
    {
      id: "saved-connection",
      integration: setup.integration,
      label: "Support",
      owner: { scope: "organization" },
      status: "active",
      isDefault: false,
      configuration: {},
      availableCredentialSlots: [],
      disconnectPending: false,
      health: { status: "unknown", checkedAt: null },
      expiresAt: null,
    },
  ]);
  vi.mocked(getOimConnectionSetup).mockResolvedValue(setup);
  renderDetailWithClientLoader("/integrations/acme-v2");
  await user.click(await screen.findByRole("button", { name: "Resume setup for Support" }));
  expect(
    await screen.findByRole("button", { name: "Continue with Authorize" })
  ).toBeInTheDocument();
  expect(getOimConnectionSetup).toHaveBeenCalledWith("acme-v2", "saved-connection");
  expect(screen.getByTestId("location-search")).toHaveTextContent("?connection=saved-connection");
  expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("API token"), "unsaved-replacement");
  await user.click(screen.getByRole("button", { name: "Add another Connection" }));
  expect(await screen.findByLabelText("Connection name")).toHaveValue("");
  expect(screen.getByLabelText("API token")).toHaveValue("");
  expect(screen.getByTestId("location-search")).toHaveTextContent("");
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Add Connection" })).toHaveFocus()
  );
  expect(createOimConnection).not.toHaveBeenCalled();
});

test("shows the earlier required upgrade field even when legacy activation and later OAuth are saved", async () => {
  renderDetail(
    detail({
      connected: true,
      status: "connected",
      auth: [
        {
          index: 0,
          kind: "fields",
          producesEnv: true,
          satisfied: false,
          fields: [{ name: "tenant", label: "Tenant" }],
        },
        { index: 1, kind: "oauth2", producesEnv: true, satisfied: true },
      ],
    })
  );
  expect(await screen.findByLabelText("Tenant")).toBeInTheDocument();
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
});

test("describes Slack's sender, mention gate and route selection rather than all messages", async () => {
  renderDetail(
    detail({ name: "slack", title: "Slack", connected: true, status: "connected" }),
    undefined,
    "/integrations/slack"
  );
  expect(await screen.findByText(/Linked senders can use 1:1 DMs/)).toHaveTextContent(
    /highest-priority matching route selects the Agent/
  );
  expect(screen.queryByText(/All Slack DMs and channel messages/)).not.toBeInTheDocument();
});

test("keeps removal behind an overflow menu and a confirm step", async () => {
  const user = userEvent.setup();
  renderDetail(detail());
  await screen.findByRole("heading", { level: 1 });

  expect(screen.queryByRole("menuitem", { name: /confirm remove/i })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /more actions/i }));
  await user.click(screen.getByRole("menuitem", { name: /remove integration/i }));
  expect(deleteIntegration).not.toHaveBeenCalled();

  await user.click(screen.getByRole("menuitem", { name: /confirm remove/i }));
  expect(deleteIntegration).toHaveBeenCalledWith("github");
});

test("retries a pending uninstall against the same installed generation", async () => {
  const user = userEvent.setup();
  const release = {
    integrationId: "acme",
    majorVersion: 2,
    installationId: "11111111-1111-4111-8111-111111111111",
    slug: "acme-v2",
  };
  const setup: OimConnectionSetup = {
    integration: { id: "acme", majorVersion: 2 },
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [],
  };
  vi.mocked(getIntegration).mockResolvedValue(
    detail({ name: "acme-v2", type: "oim", title: "Acme" })
  );
  vi.mocked(listOimConnections).mockResolvedValue([]);
  vi.mocked(getOimConnectionSetup).mockResolvedValue(setup);
  vi.mocked(getInstalledOimRelease).mockResolvedValue(release);
  vi.mocked(getOimReleaseUninstallStatus)
    .mockResolvedValueOnce({
      scope: release,
      status: "not_started",
      activationAllowed: true,
      retryRequired: false,
    })
    .mockResolvedValue({
      scope: release,
      status: "pending",
      activationAllowed: false,
      retryRequired: true,
    });
  vi.mocked(uninstallOimRelease).mockRejectedValue(new Error("remote cleanup failed"));

  renderDetailWithClientLoader("/integrations/acme-v2");

  await user.click(await screen.findByRole("button", { name: "More actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Remove integration" }));
  await user.click(screen.getByRole("menuitem", { name: "Confirm remove" }));

  expect(
    await screen.findByRole("heading", { name: "Removal needs another try" })
  ).toBeInTheDocument();
  expect(
    screen.getByText("Provider cleanup did not finish. Retry this exact installation.")
  ).toBeInTheDocument();
  expect(window.location.search).toContain(`installation=${release.installationId}`);
  expect(uninstallOimRelease).toHaveBeenCalledWith(release);
  expect(deleteIntegration).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Retry removal" }));

  expect(uninstallOimRelease).toHaveBeenCalledTimes(2);
  expect(vi.mocked(uninstallOimRelease).mock.calls).toEqual([[release], [release]]);
});

test("keeps a pinned uninstall generation without resolving the latest installation", async () => {
  const installationId = "11111111-1111-4111-8111-111111111111";
  vi.mocked(getIntegration).mockResolvedValue(
    detail({ name: "acme-v2", type: "oim", title: "Acme" })
  );
  vi.mocked(listOimConnections).mockResolvedValue([]);
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    integration: { id: "acme", majorVersion: 2 },
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [],
  });
  vi.mocked(getOimReleaseUninstallStatus).mockResolvedValue({
    scope: { integrationId: "acme", majorVersion: 2, installationId },
    status: "pending",
    activationAllowed: false,
    retryRequired: true,
  });

  const result = await clientLoader({
    params: { name: "acme-v2" },
    request: new Request(
      `https://app.example.test/integrations/acme-v2?installation=${installationId}`
    ),
    context: {},
  } as never);

  expect(result.oimRelease).toEqual({
    integrationId: "acme",
    majorVersion: 2,
    installationId,
    slug: "acme-v2",
  });
  expect(getInstalledOimRelease).not.toHaveBeenCalled();
  expect(getOimReleaseUninstallStatus).toHaveBeenCalledWith(result.oimRelease);
});

test("does not offer package uninstall for a bundled OIM provider", async () => {
  vi.mocked(getIntegration).mockResolvedValue(
    detail({ name: "acme-v2", type: "oim", title: "Acme" })
  );
  vi.mocked(listOimConnections).mockResolvedValue([]);
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    integration: { id: "acme", majorVersion: 2 },
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [],
  });

  renderDetailWithClientLoader("/integrations/acme-v2");

  await screen.findByRole("heading", { name: "Add Connection" });
  expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
  expect(getInstalledOimRelease).toHaveBeenCalledWith("acme", 2);
});

test("changes auto-patch only for the installed Official package major", async () => {
  const user = userEvent.setup();
  const release = {
    integrationId: "acme",
    majorVersion: 2,
    installationId: "11111111-1111-4111-8111-111111111111",
    slug: "acme-v2",
    trustClass: "official" as const,
    autoPatchOptIn: false,
  };
  vi.mocked(getIntegration).mockResolvedValue(
    detail({ name: "acme-v2", type: "oim", title: "Acme" })
  );
  vi.mocked(listOimConnections).mockResolvedValue([]);
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    integration: { id: "acme", majorVersion: 2 },
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [],
  });
  vi.mocked(getInstalledOimRelease).mockResolvedValue(release);
  vi.mocked(getOimReleaseUninstallStatus).mockResolvedValue({
    scope: release,
    status: "not_started",
    activationAllowed: true,
    retryRequired: false,
  });
  vi.mocked(setOimAutoPatchPreference).mockResolvedValue({
    ...release,
    autoPatchOptIn: true,
  });

  renderDetailWithClientLoader("/integrations/acme-v2");
  const heading = await screen.findByRole("heading", { name: "Official package updates" });
  const section = heading.closest("section") as HTMLElement;
  const toggle = within(section).getByRole("checkbox", {
    name: "Automatically install verified patch releases",
  });
  await user.click(toggle);

  expect(setOimAutoPatchPreference).toHaveBeenCalledWith("acme", 2, true);
  await waitFor(() =>
    expect(within(section).getByRole("status")).toHaveTextContent(
      "Automatic patch updates enabled for this Official package."
    )
  );
});

test("never offers auto-patch for a Community package", async () => {
  const release = {
    integrationId: "acme",
    majorVersion: 2,
    installationId: "11111111-1111-4111-8111-111111111111",
    slug: "acme-v2",
    trustClass: "community" as const,
    autoPatchOptIn: false,
  };
  vi.mocked(getIntegration).mockResolvedValue(
    detail({ name: "acme-v2", type: "oim", title: "Acme" })
  );
  vi.mocked(listOimConnections).mockResolvedValue([]);
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    integration: { id: "acme", majorVersion: 2 },
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [],
  });
  vi.mocked(getInstalledOimRelease).mockResolvedValue(release);
  vi.mocked(getOimReleaseUninstallStatus).mockResolvedValue({
    scope: release,
    status: "not_started",
    activationAllowed: true,
    retryRequired: false,
  });

  renderDetailWithClientLoader("/integrations/acme-v2");

  expect(await screen.findByText(/Each Community package digest must be reviewed/)).toBeVisible();
  expect(
    screen.queryByRole("checkbox", { name: /Automatically install verified patch releases/ })
  ).not.toBeInTheDocument();
});

test("ignores late auto-patch failure after navigation to another installation", async () => {
  let rejectUpdate: (reason: unknown) => void = () => {};
  vi.mocked(setOimAutoPatchPreference).mockReturnValue(
    new Promise((_, reject) => {
      rejectUpdate = reject;
    })
  );
  vi.mocked(getIntegration).mockImplementation(async (name) =>
    detail({ name, type: "oim", title: name === "acme-v2" ? "Acme" : "Other" })
  );
  vi.mocked(listOimConnections).mockResolvedValue([]);
  vi.mocked(getOimConnectionSetup).mockImplementation(async (name) => ({
    integration:
      name === "acme-v2" ? { id: "acme", majorVersion: 2 } : { id: "other", majorVersion: 2 },
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [],
  }));
  vi.mocked(getInstalledOimRelease).mockImplementation(async (integrationId) => ({
    integrationId,
    majorVersion: 2,
    installationId:
      integrationId === "acme"
        ? "11111111-1111-4111-8111-111111111111"
        : "22222222-2222-4222-8222-222222222222",
    slug: integrationId === "acme" ? "acme-v2" : "other",
    trustClass: "official",
    autoPatchOptIn: false,
  }));
  vi.mocked(getOimReleaseUninstallStatus).mockImplementation(async (scope) => ({
    scope,
    status: "not_started",
    activationAllowed: true,
    retryRequired: false,
  }));
  const user = userEvent.setup();

  renderDetailWithClientLoader("/integrations/acme-v2");
  await user.click(
    await screen.findByRole("checkbox", {
      name: "Automatically install verified patch releases",
    })
  );
  await user.click(screen.getByRole("button", { name: "Switch test integration" }));
  await screen.findByRole("heading", { level: 1, name: "Other" });
  rejectUpdate(new Error("late update failure"));

  await waitFor(() => {
    expect(screen.queryByText("late update failure")).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: "Automatically install verified patch releases",
      })
    ).not.toBeDisabled();
  });
});

test("shows the connect flow only while disconnected", async () => {
  renderDetail(
    detail({
      connected: true,
      status: "connected",
      auth: [{ index: 0, kind: "fields", satisfied: true, producesEnv: true, fields: [] }],
    })
  );
  await screen.findByRole("heading", { level: 1 });
  expect(screen.queryByText(/^connect$/i)).not.toBeInTheDocument();
});

test("says so plainly when an integration needs no credentials at all", async () => {
  renderDetail(detail({ connected: false, auth: [] }));
  expect(await screen.findByText(/declares no credentials/i)).toBeInTheDocument();
});

test("offers a member no way to connect, and says why instead", async () => {
  admin = false;
  renderDetail(
    detail({
      connected: false,
      auth: [{ index: 0, kind: "fields", satisfied: false, producesEnv: true, fields: [] }],
    })
  );
  await screen.findByRole("heading", { level: 1 });

  expect(screen.getByText(/^connect$/i)).toBeInTheDocument();
  expect(await screen.findByText(/an admin has to do it/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^continue$/i })).not.toBeInTheDocument();
});

test("hides disconnect and remove from a member", async () => {
  admin = false;
  renderDetail(detail({ connected: true, status: "connected" }));
  await screen.findByRole("heading", { level: 1 });

  expect(screen.queryByRole("button", { name: /disconnect/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /more actions/i })).not.toBeInTheDocument();
});

test("still shows a member what the integration is and whether it is connected", async () => {
  admin = false;
  renderDetail(
    detail({
      connected: true,
      status: "connected",
      description: "Issues, pull requests and code review.",
      capabilities: ["Open a pull request"],
    })
  );
  await screen.findByRole("heading", { level: 1 });

  expect(screen.getByText("Connected")).toBeInTheDocument();
  expect(screen.getByText(/issues, pull requests/i)).toBeInTheDocument();
  expect(screen.getByText("Open a pull request")).toBeInTheDocument();
});

test("offers every signed-in user their own GitHub connect action", async () => {
  admin = false;
  renderDetail(
    detail({
      connected: true,
      status: "connected",
      auth: [
        {
          index: 3,
          kind: "oauth2",
          personal: true,
          satisfied: false,
          producesEnv: true,
        },
      ],
    })
  );

  expect(
    await screen.findByRole("button", { name: "Connect your GitHub account" })
  ).toBeInTheDocument();
  expect(screen.getByText(/never fall back to the business's GitHub App/i)).toBeInTheDocument();
});

test("hides the personal connect button until the fields step it depends on is satisfied", async () => {
  admin = false;
  renderDetail(
    detail({
      // `connected` reflects App-install status (a different, later step) and must not gate this.
      connected: true,
      status: "connected",
      auth: [
        {
          index: 1,
          kind: "fields",
          title: "Configure personal GitHub access",
          satisfied: false,
          producesEnv: true,
          fields: [{ name: "GITHUB_OAUTH_CLIENT_ID", label: "Client ID" }],
        },
        {
          index: 3,
          kind: "oauth2",
          personal: true,
          satisfied: false,
          producesEnv: true,
        },
      ],
    })
  );

  await screen.findByRole("heading", { level: 1 });
  expect(
    screen.queryByRole("button", { name: "Connect your GitHub account" })
  ).not.toBeInTheDocument();
});

test("shows the personal connect button once the fields step it depends on is satisfied", async () => {
  admin = false;
  renderDetail(
    detail({
      connected: false,
      status: "disconnected",
      auth: [
        {
          index: 1,
          kind: "fields",
          title: "Configure personal GitHub access",
          satisfied: true,
          producesEnv: true,
          fields: [{ name: "GITHUB_OAUTH_CLIENT_ID", label: "Client ID" }],
        },
        {
          index: 3,
          kind: "oauth2",
          personal: true,
          satisfied: false,
          producesEnv: true,
        },
      ],
    })
  );

  expect(
    await screen.findByRole("button", { name: "Connect your GitHub account" })
  ).toBeInTheDocument();
});

test("keeps a personal OAuth step out of the administrator's business setup rail", async () => {
  renderDetail(
    detail({
      connected: false,
      auth: [
        {
          index: 0,
          kind: "fields",
          title: "Business app",
          satisfied: false,
          producesEnv: true,
          fields: [{ name: "APP_ID", label: "App ID" }],
        },
        {
          index: 1,
          kind: "oauth2",
          title: "Connect your GitHub account",
          personal: true,
          satisfied: false,
          producesEnv: true,
        },
      ],
    })
  );

  expect((await screen.findAllByText("Business app")).length).toBeGreaterThan(0);
  expect(screen.queryByText("Connect your GitHub account")).not.toBeInTheDocument();
});

test("shows update button and update banner when an update is available", async () => {
  renderDetail(
    detail({
      name: "linear",
      title: "Linear",
      source: "acme/linear",
      updateAvailable: true,
    })
  );

  expect(await screen.findByText(/update available/i)).toBeInTheDocument();
  const updateButtons = screen.getAllByRole("button", { name: /^update/i });
  expect(updateButtons.length).toBeGreaterThan(0);
});

test("updates through the API when update is clicked", async () => {
  const user = userEvent.setup();
  vi.mocked(updateIntegration).mockResolvedValue({
    name: "linear",
    source: "acme/linear",
    ref: "main",
  });

  renderDetail(
    detail({
      name: "linear",
      title: "Linear",
      source: "acme/linear",
      updateAvailable: true,
    })
  );

  const updateButton = (await screen.findAllByRole("button", { name: /^update/i }))[0];
  await user.click(updateButton);

  expect(updateIntegration).toHaveBeenCalledWith("linear", "acme/linear");
});

test("hides update button from a member even when an update is available", async () => {
  admin = false;
  renderDetail(
    detail({
      name: "linear",
      title: "Linear",
      source: "acme/linear",
      updateAvailable: true,
    })
  );

  expect(await screen.findByText(/update available/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^update/i })).not.toBeInTheDocument();
});
