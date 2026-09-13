import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import {
  type OimConnectionSummary,
  refreshOimConnection,
  revokeOimConnection,
  startOimConnectionAuthorization,
} from "~/lib/integrations";
import { OimConnections } from "./oim-connections";

vi.mock("~/lib/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/integrations")>()),
  refreshOimConnection: vi.fn(),
  revokeOimConnection: vi.fn(),
  startOimConnectionAuthorization: vi.fn(),
}));

function connection(
  id: string,
  overrides: Partial<OimConnectionSummary> = {}
): OimConnectionSummary {
  return {
    id,
    integration: { id: "acme", majorVersion: 2 },
    label: id === "connection-1" ? "Support" : "Finance",
    owner: { scope: "organization" },
    status: "active",
    isDefault: id === "connection-1",
    configuration: {},
    availableCredentialSlots: ["access_token"],
    disconnectPending: false,
    health: { status: "healthy", checkedAt: "2026-09-13T10:00:00.000Z" },
    expiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("revokes the exact selected Connection after confirmation", async () => {
  const user = userEvent.setup();
  const onChanged = vi.fn();
  vi.mocked(revokeOimConnection).mockResolvedValue({ status: "revoked" });

  render(
    <OimConnections
      integrationKey="acme-v2"
      connections={[connection("connection-1"), connection("connection-2")]}
      onChanged={onChanged}
    />
  );

  const finance = screen.getByText("Finance").closest("li") as HTMLElement;
  await user.click(within(finance).getByRole("button", { name: "Disconnect Finance" }));
  await user.click(screen.getByRole("button", { name: "Disconnect Connection" }));

  expect(revokeOimConnection).toHaveBeenCalledWith("acme-v2", "connection-2");
  expect(onChanged).toHaveBeenCalledOnce();
});

test("reports durable cleanup as pending instead of a successful disconnect", async () => {
  const user = userEvent.setup();
  vi.mocked(revokeOimConnection).mockResolvedValue({ status: "disconnect_pending" });

  render(
    <OimConnections
      integrationKey="acme-v2"
      connections={[connection("connection-1")]}
      onChanged={vi.fn()}
    />
  );

  await user.click(screen.getByRole("button", { name: "Disconnect Support" }));
  await user.click(screen.getByRole("button", { name: "Disconnect Connection" }));

  expect(screen.getByText(/disconnect is pending provider cleanup/i)).toBeInTheDocument();
});

test("does not offer ordinary actions while durable disconnect cleanup is pending", () => {
  render(
    <OimConnections
      integrationKey="acme-v2"
      connections={[connection("connection-1", { disconnectPending: true })]}
      onChanged={vi.fn()}
    />
  );

  expect(screen.getByText("Disconnecting")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /check authorization/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /disconnect support/i })).not.toBeInTheDocument();
});

test("recovers only the exact OAuth step reported by refresh", async () => {
  const user = userEvent.setup();
  vi.mocked(refreshOimConnection).mockResolvedValue({
    connectionId: "connection-1",
    health: "action_required",
    steps: [
      { stepId: "account", status: "renewed" },
      { stepId: "admin-consent", status: "action_required", error: "missing_step" },
    ],
  });
  vi.mocked(startOimConnectionAuthorization).mockResolvedValue({ action: "completed" });

  render(
    <OimConnections
      integrationKey="acme-v2"
      connections={[
        connection("connection-1", {
          health: { status: "action_required", checkedAt: "2026-09-13T10:00:00.000Z" },
        }),
      ]}
      onChanged={vi.fn()}
    />
  );

  await user.click(screen.getByRole("button", { name: "Check authorization for Support" }));
  expect(await screen.findByRole("heading", { name: "Sign in again" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /reauthorize account$/i })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Reauthorize admin-consent for Support" }));
  expect(startOimConnectionAuthorization).toHaveBeenCalledWith(
    "acme-v2",
    "connection-1",
    "admin-consent"
  );
});

test("gives duplicate Connection actions distinct accessible names", async () => {
  render(
    <OimConnections
      integrationKey="acme-v2"
      connections={[
        connection("connection-1", { label: "Support" }),
        connection("connection-2", { label: "Support" }),
      ]}
      onChanged={vi.fn()}
    />
  );

  expect(
    screen.getByRole("button", {
      name: "Check authorization for Support, Connection connection-1",
    })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Disconnect Support, Connection connection-1" })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", {
      name: "Check authorization for Support, Connection connection-2",
    })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Disconnect Support, Connection connection-2" })
  ).toBeInTheDocument();
});
