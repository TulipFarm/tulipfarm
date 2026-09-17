import { beforeEach, expect, test, vi } from "vitest";
import { clientLoader } from "~/routes/_app.integrations._index";
import {
  connectionPresentation,
  connectionsPresentation,
  resolveIntegrationStatus,
} from "./integration-status";
import {
  getOimConnectionSetup,
  listIntegrations,
  listOimConnections,
  type OimConnectionSummary,
} from "./integrations";

vi.mock("./integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./integrations")>()),
  getOimConnectionSetup: vi.fn(),
  listOimConnections: vi.fn(),
  listIntegrations: vi.fn(),
}));

const integration = {
  name: "provider",
  type: "oim",
  installed: true,
  status: "connected" as const,
};
const connection: OimConnectionSummary = {
  id: "saved-connection",
  integration: { id: "provider", majorVersion: 1 },
  label: "Support",
  owner: { scope: "organization" },
  status: "active",
  isDefault: false,
  configuration: {},
  availableCredentialSlots: ["token"],
  disconnectPending: false,
  health: { status: "healthy", checkedAt: null },
  expiresAt: null,
};

beforeEach(() => vi.resetAllMocks());

test.each([
  { ...connection, health: { status: "action_required" as const, checkedAt: null } },
  { ...connection, availableCredentialSlots: [] },
  { ...connection, disconnectPending: true },
  { ...connection, expiresAt: "2020-01-01T00:00:00Z" },
])("uses the same unusable projection in catalog, header and row: %j", async (unusable) => {
  vi.mocked(listOimConnections).mockResolvedValue([unusable]);
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    integration: connection.integration,
    allowedOwnerScopes: ["personal"],
    configurationFields: [],
    fieldSteps: [
      {
        id: "credentials",
        title: "Credentials",
        fields: [{ id: "token", label: "Token", input: "password", secret: true, required: true }],
      },
    ],
    initialAuthorizationSteps: [],
    pendingAuthorizationStepIds: [],
  });
  const result = await resolveIntegrationStatus(integration);
  expect(result.status).toBe("disconnected");
  expect(result.connectionState).toEqual(connectionsPresentation([unusable]));
  expect(result.connectionState).toEqual(connectionPresentation(unusable));
});

test("catalog loader checks exact setup instead of trusting healthy credentials with a pending install", async () => {
  vi.mocked(listIntegrations).mockResolvedValue([integration]);
  vi.mocked(listOimConnections).mockResolvedValue([connection]);
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    integration: connection.integration,
    allowedOwnerScopes: ["organization"],
    configurationFields: [],
    fieldSteps: [],
    initialAuthorizationSteps: [{ id: "install", title: "Install", type: "install" }],
    pendingAuthorizationStepIds: ["install"],
  });
  const result = await clientLoader();
  expect(getOimConnectionSetup).toHaveBeenCalledWith("provider", "saved-connection");
  expect(result.integrations[0]).toMatchObject({
    status: "disconnected",
    connectionState: { label: "Setup incomplete", usable: false },
  });
});

test("status lookup failure does not reuse a stale Connected catalog claim", async () => {
  vi.mocked(listOimConnections).mockRejectedValue(new Error("Unavailable"));
  expect(await resolveIntegrationStatus(integration)).toMatchObject({
    status: "error",
    connectionState: { label: "Status unavailable", usable: false },
  });
});

test.each([connection, { ...connection, availableCredentialSlots: [] }])(
  "healthy access, including credential-free packages, needs successful exact setup: %j",
  async (healthyConnection) => {
    vi.mocked(listOimConnections).mockResolvedValue([healthyConnection]);
    vi.mocked(getOimConnectionSetup).mockRejectedValue(new Error("Unavailable"));
    expect(await resolveIntegrationStatus(integration)).toMatchObject({
      connectionState: { label: "Status unavailable", usable: false },
    });
    vi.mocked(getOimConnectionSetup).mockResolvedValue({
      integration: connection.integration,
      allowedOwnerScopes: ["personal"],
      configurationFields: [],
      fieldSteps: [],
      initialAuthorizationSteps: [],
      pendingAuthorizationStepIds: [],
    });
    expect(await resolveIntegrationStatus(integration)).toMatchObject({
      status: "connected",
      connectionState: { label: "Connected", usable: true },
    });
  }
);
