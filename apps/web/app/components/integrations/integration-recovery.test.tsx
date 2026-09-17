import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import {
  connectIntegration,
  type IntegrationDetail,
  type OimConnectionSummary,
  updateOimConnectionCredentials,
} from "~/lib/integrations";
import IntegrationDetailPage from "~/routes/_app.integrations.$name";
import { IntegrationAuthFlow } from "./auth-flow";
import { OimConnectionSetup } from "./oim-connection-setup";
import { OimConnections } from "./oim-connections";

vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: () => true }));
vi.mock("~/lib/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/integrations")>()),
  connectIntegration: vi.fn(),
  updateOimConnectionCredentials: vi.fn(),
}));

const connection: OimConnectionSummary = {
  id: "saved-connection",
  integration: { id: "provider", majorVersion: 1 },
  label: "Support",
  owner: { scope: "organization" },
  status: "active",
  isDefault: false,
  configuration: {},
  availableCredentialSlots: [],
  disconnectPending: false,
  health: { status: "action_required", checkedAt: null },
  expiresAt: null,
};

beforeEach(() => vi.clearAllMocks());

function detail(connections?: OimConnectionSummary[]) {
  const integration: IntegrationDetail = {
    name: "provider",
    type: connections ? "oim" : "none",
    installed: true,
    status: "disconnected",
    connected: false,
    grants: [],
    auth: connections
      ? []
      : [{ index: 0, kind: "fields", satisfied: true, producesEnv: true, fields: [] }],
    manifest: {},
  };
  const Stub = createRemixStub([
    {
      path: "/integrations/:name",
      Component: IntegrationDetailPage,
      loader: () => ({
        integration,
        usesOimConnections: !!connections,
        oimConnections: connections,
        githubInstallations: [],
      }),
    },
  ]);
  render(<Stub initialEntries={["/integrations/provider"]} />);
}

test.each([
  connection,
  {
    ...connection,
    disconnectPending: true,
    health: { status: "healthy" as const, checkedAt: null },
  },
  {
    ...connection,
    availableCredentialSlots: ["token"],
    health: { status: "healthy" as const, checkedAt: null },
    expiresAt: "2020-01-01T00:00:00Z",
  },
])("does not claim Connected for unusable active access (%j)", async (unusable) => {
  detail([unusable]);
  await screen.findByText("Support");
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
});

test("offers Resume setup for the exact existing Connection", () => {
  const onResume = vi.fn();
  render(
    <OimConnections
      integrationKey="provider"
      connections={[connection]}
      onChanged={vi.fn()}
      onResume={onResume}
    />
  );
  screen.getByRole("button", { name: "Resume setup for Support" }).click();
  expect(onResume).toHaveBeenCalledWith("saved-connection");
});

test("corrects a rejected static credential without replacing the Connection", async () => {
  const user = userEvent.setup();
  vi.mocked(updateOimConnectionCredentials).mockResolvedValue({
    connectionId: connection.id,
    verification: { status: "verified" },
  });
  const onChanged = vi.fn();
  render(
    <OimConnectionSetup
      integrationKey="provider"
      connectionId={connection.id}
      setup={{
        integration: connection.integration,
        connectionHealth: "action_required",
        allowedOwnerScopes: ["organization"],
        configurationFields: [],
        fieldSteps: [
          {
            id: "credentials",
            title: "Credentials",
            fields: [
              { id: "token", label: "API token", input: "password", required: true, secret: true },
            ],
          },
        ],
        initialAuthorizationSteps: [],
        pendingAuthorizationStepIds: [],
      }}
      onChanged={onChanged}
    />
  );
  await user.type(screen.getByLabelText("API token"), "corrected-token");
  await user.click(screen.getByRole("button", { name: "Save credentials and verify" }));
  expect(updateOimConnectionCredentials).toHaveBeenCalledWith("provider", "saved-connection", {
    token: "corrected-token",
  });
  expect(await screen.findByRole("status")).toHaveTextContent("Connection verified.");
  expect(onChanged).toHaveBeenCalled();
  expect(screen.getByLabelText("API token")).toHaveValue("");
});

test("offers explicit Reconnect when disconnected legacy credentials are already saved", async () => {
  const user = userEvent.setup();
  vi.mocked(connectIntegration).mockResolvedValue({ status: "connected", toolCount: 0 });
  detail();
  await user.click(await screen.findByRole("button", { name: "Reconnect" }));
  expect(connectIntegration).toHaveBeenCalledWith("provider", {});
});

test("does not skip a newly required earlier field because later OAuth is satisfied", () => {
  render(
    <IntegrationAuthFlow
      slug="provider"
      providerLabel="Provider"
      steps={[
        {
          index: 0,
          kind: "fields",
          satisfied: false,
          producesEnv: true,
          fields: [{ name: "tenant", label: "Tenant" }],
        },
        { index: 1, kind: "oauth2", satisfied: true, producesEnv: true },
      ]}
      onAdvance={vi.fn()}
    />
  );
  expect(screen.getByLabelText("Tenant")).toBeInTheDocument();
});
