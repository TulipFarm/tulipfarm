import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import {
  getIntegrationOperations,
  type IntegrationOperationsView,
  saveKnowledgeSubscription,
} from "~/lib/integration-operations";
import { IntegrationOperations } from "./integration-operations";

vi.mock("~/lib/integration-operations", () => ({
  getIntegrationOperations: vi.fn(),
  saveKnowledgeSubscription: vi.fn(),
}));

function view(): IntegrationOperationsView {
  return {
    sourceKinds: [{ id: "space", label: "Space" }],
    liveAuthorization: true,
    ingress: null,
    observedAt: "2026-09-17T12:00:00Z",
    connections: [
      {
        connectionId: "selected",
        label: "Support",
        authorization: "healthy",
        disconnectPending: false,
        subscriptions: [],
        operations: {
          webhook: null,
          polling: null,
          sync: [],
          delivery: {
            pending: 0,
            retrying: 0,
            deadLetter: 0,
            dispatched: 0,
            nextAttemptAt: null,
            hasError: false,
          },
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getIntegrationOperations).mockResolvedValue(view());
});

test("saves exact selected scopes through the supported client without claiming sync success", async () => {
  const user = userEvent.setup();
  vi.mocked(saveKnowledgeSubscription).mockResolvedValue({
    sourceKindId: "space",
    scopes: ["space-one"],
    enabled: true,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorCodes: [],
  });
  render(<IntegrationOperations integrationKey="wiki" />);
  await user.type(await screen.findByLabelText("Space scopes"), "space-one\nspace-two");
  expect(screen.getByText(/Last completed sync: Not recorded/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Enable Knowledge sync" }));
  await waitFor(() =>
    expect(saveKnowledgeSubscription).toHaveBeenCalledWith("wiki", "selected", {
      sourceKindId: "space",
      scopes: ["space-one", "space-two"],
      enabled: true,
    })
  );
  expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
});

test("disables with durable scopes rather than unsaved editor changes", async () => {
  const data = view();
  const connection = data.connections[0];
  if (!connection) throw new Error("fixture Connection missing");
  connection.subscriptions = [
    {
      sourceKindId: "space",
      scopes: ["saved"],
      enabled: true,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorCodes: ["acl_failed"],
    },
  ];
  vi.mocked(getIntegrationOperations).mockResolvedValue(data);
  const user = userEvent.setup();
  render(<IntegrationOperations integrationKey="wiki" />);
  const scopes = await screen.findByLabelText("Space scopes");
  await user.clear(scopes);
  await user.type(scopes, "unsaved");
  await user.click(screen.getByRole("button", { name: "Disable sync" }));
  await waitFor(() =>
    expect(saveKnowledgeSubscription).toHaveBeenCalledWith("wiki", "selected", {
      sourceKindId: "space",
      scopes: ["saved"],
      enabled: false,
    })
  );
});

test("shows unavailable evidence rather than zero backlog on read failure", async () => {
  vi.mocked(getIntegrationOperations).mockRejectedValue(new ApiError(403, "Forbidden"));
  render(<IntegrationOperations integrationKey="wiki" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Operational status is unavailable");
  expect(screen.queryByText(/0 pending/)).not.toBeInTheDocument();
});

test("rejects unsupported websocket expectations and blocks unauthorized sync setup", async () => {
  const data = view();
  data.ingress = "websocket";
  const connection = data.connections[0];
  if (!connection) throw new Error("fixture Connection missing");
  connection.authorization = "action_required";
  vi.mocked(getIntegrationOperations).mockResolvedValue(data);
  render(<IntegrationOperations integrationKey="wiki" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("does not support");
  expect(screen.getByRole("button", { name: "Enable Knowledge sync" })).toBeDisabled();
});
