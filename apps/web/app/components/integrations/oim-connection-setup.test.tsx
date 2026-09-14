import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import {
  createOimConnection,
  getOimConnectionSetup,
  refreshOimConnection,
  startOimConnectionAuthorization,
} from "~/lib/integrations";
import { followAuthAction } from "./auth-flow";
import { OimConnectionSetup } from "./oim-connection-setup";

vi.mock("./auth-flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-flow")>()),
  followAuthAction: vi.fn(() => "completed"),
}));

vi.mock("~/lib/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/integrations")>()),
  createOimConnection: vi.fn(),
  getOimConnectionSetup: vi.fn(),
  refreshOimConnection: vi.fn(),
  startOimConnectionAuthorization: vi.fn(),
}));

const setup = {
  integration: { id: "acme", majorVersion: 2 },
  allowedOwnerScopes: ["personal"] as const,
  configurationFields: [
    {
      id: "workspace",
      label: "Workspace URL",
      type: "url" as const,
      required: true,
      agentVisible: true,
    },
  ],
  fieldSteps: [
    {
      id: "credentials",
      title: "Add credentials",
      fields: [
        {
          id: "client_id",
          label: "Client ID",
          input: "text" as const,
          required: true,
          secret: true,
        },
        {
          id: "client_secret",
          label: "Client secret",
          input: "password" as const,
          required: true,
          secret: true,
        },
        {
          id: "workspace",
          label: "Workspace URL",
          input: "url" as const,
          required: true,
          secret: false,
        },
      ],
    },
  ],
  initialAuthorizationSteps: [
    { id: "app", title: "Create app", type: "app_manifest" as const },
    { id: "account", title: "Authorize account", type: "oauth2" as const },
  ],
};

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createdConnection() {
  return {
    connectionId: "connection-1",
    verification: { status: "not_required" as const },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("creates a Connection from reviewed fields and starts its exact pending step", async () => {
  const user = userEvent.setup();
  const onChanged = vi.fn();
  const onConnectionSelected = vi.fn();
  vi.mocked(createOimConnection).mockResolvedValue(createdConnection());
  vi.mocked(getOimConnectionSetup)
    .mockResolvedValueOnce({ ...setup, pendingAuthorizationStepIds: ["app", "account"] })
    .mockResolvedValueOnce({ ...setup, pendingAuthorizationStepIds: ["account"] });
  vi.mocked(startOimConnectionAuthorization).mockResolvedValue({ action: "completed" });

  render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={setup}
      onConnectionSelected={onConnectionSelected}
      onChanged={onChanged}
    />
  );

  await user.type(screen.getByLabelText("Connection name"), "Support");
  await user.type(screen.getByLabelText("Client ID"), "client-id");
  await user.type(screen.getByLabelText("Client secret"), "client-secret");
  await user.type(screen.getByLabelText("Workspace URL"), "https://workspace.example.test");
  await user.click(screen.getByRole("button", { name: "Create Connection" }));

  expect(createOimConnection).toHaveBeenCalledWith("acme-v2", {
    label: "Support",
    ownerScope: "personal",
    values: {
      client_id: "client-id",
      client_secret: "client-secret",
      workspace: "https://workspace.example.test",
    },
  });
  expect(
    await screen.findByRole("button", { name: "Continue with Create app" })
  ).toBeInTheDocument();
  expect(onConnectionSelected).toHaveBeenCalledWith("connection-1");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Connection created. Finish provider authorization."
  );
  expect(screen.getByRole("heading", { name: "Finish provider authorization" })).toHaveFocus();

  await user.click(screen.getByRole("button", { name: "Continue with Create app" }));

  expect(startOimConnectionAuthorization).toHaveBeenCalledWith("acme-v2", "connection-1", "app");
  expect(
    await screen.findByRole("button", { name: "Continue with Authorize account" })
  ).toBeInTheDocument();
  expect(onChanged).toHaveBeenCalled();
});

test("keeps the created Connection during a stale generic route revalidation", async () => {
  const user = userEvent.setup();
  vi.mocked(createOimConnection).mockResolvedValue(createdConnection());
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    ...setup,
    pendingAuthorizationStepIds: ["account"],
  });

  const { rerender } = render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={{ ...setup }}
      onConnectionSelected={vi.fn()}
      onChanged={vi.fn()}
    />
  );

  await user.type(screen.getByLabelText("Connection name"), "Support");
  await user.type(screen.getByLabelText("Client ID"), "client-id");
  await user.type(screen.getByLabelText("Client secret"), "client-secret");
  await user.type(screen.getByLabelText("Workspace URL"), "https://workspace.example.test");
  await user.click(screen.getByRole("button", { name: "Create Connection" }));

  expect(
    await screen.findByRole("button", { name: "Continue with Authorize account" })
  ).toBeInTheDocument();

  rerender(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={setup}
      onConnectionSelected={vi.fn()}
      onChanged={vi.fn()}
    />
  );

  expect(
    screen.getByRole("button", { name: "Continue with Authorize account" })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Continue with Create app" })
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
});

test("retries setup loading without creating a second Connection", async () => {
  const user = userEvent.setup();
  const onConnectionSelected = vi.fn();
  vi.mocked(createOimConnection).mockResolvedValue(createdConnection());
  vi.mocked(getOimConnectionSetup)
    .mockRejectedValueOnce(new Error("Setup is temporarily unavailable."))
    .mockResolvedValueOnce({
      ...setup,
      pendingAuthorizationStepIds: ["account"],
    });

  render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={setup}
      onConnectionSelected={onConnectionSelected}
      onChanged={vi.fn()}
    />
  );

  await user.type(screen.getByLabelText("Connection name"), "Support");
  await user.type(screen.getByLabelText("Client ID"), "client-id");
  await user.type(screen.getByLabelText("Client secret"), "client-secret");
  await user.type(screen.getByLabelText("Workspace URL"), "https://workspace.example.test");
  await user.click(screen.getByRole("button", { name: "Create Connection" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Setup is temporarily unavailable.");
  expect(onConnectionSelected).toHaveBeenCalledWith("connection-1");
  expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry setup" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Connection created. Setup details could not load. Retry to continue."
  );
  expect(screen.getByRole("heading", { name: "Connection created" })).toHaveFocus();
  expect(createOimConnection).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "Retry setup" }));

  expect(
    await screen.findByRole("button", { name: "Continue with Authorize account" })
  ).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Connection created. Finish provider authorization."
  );
  expect(screen.getByRole("heading", { name: "Finish provider authorization" })).toHaveFocus();
  expect(getOimConnectionSetup).toHaveBeenCalledTimes(2);
  expect(createOimConnection).toHaveBeenCalledTimes(1);
});

test("announces accurate setup state when an existing Connection recovers", async () => {
  const existingSetup = {
    ...setup,
    pendingAuthorizationStepIds: ["account"],
  };
  const { rerender } = render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setupError="Setup is temporarily unavailable."
      connectionId="connection-1"
      onChanged={vi.fn()}
    />
  );

  expect(screen.getByRole("heading", { name: "Connection selected" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Connection setup could not load. Retry to continue."
  );

  rerender(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={existingSetup}
      connectionId="connection-1"
      onChanged={vi.fn()}
    />
  );

  expect(
    await screen.findByRole("button", { name: "Continue with Authorize account" })
  ).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Connection setup loaded. Finish provider authorization."
  );
  expect(screen.getByRole("status")).not.toHaveTextContent("could not load");
  expect(screen.getByRole("heading", { name: "Finish provider authorization" })).toHaveFocus();
});

test("does not claim a Connection was created when generic setup is unavailable", () => {
  render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setupError="Setup is temporarily unavailable."
      onChanged={vi.fn()}
    />
  );

  expect(screen.getByRole("heading", { name: "Connection setup unavailable" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Connection created" })).not.toBeInTheDocument();
  expect(createOimConnection).not.toHaveBeenCalled();
});

test("keeps valid owner scope and clears incompatible owner state when scopes change", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={{ ...setup, allowedOwnerScopes: ["team", "organization"] }}
      onChanged={vi.fn()}
    />
  );

  await user.type(screen.getByLabelText("Team ID"), "team-1");

  rerender(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={{ ...setup, allowedOwnerScopes: ["organization", "team"] }}
      onChanged={vi.fn()}
    />
  );
  expect(screen.getByLabelText("Owner")).toHaveValue("team");
  expect(screen.getByLabelText("Team ID")).toHaveValue("team-1");

  rerender(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={{ ...setup, allowedOwnerScopes: ["organization"] }}
      onChanged={vi.fn()}
    />
  );
  expect(screen.getByLabelText("Owner")).toHaveValue("organization");
  expect(screen.queryByLabelText("Team ID")).not.toBeInTheDocument();

  rerender(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={{ ...setup, allowedOwnerScopes: ["team"] }}
      onChanged={vi.fn()}
    />
  );
  expect(screen.getByLabelText("Owner")).toHaveValue("team");
  expect(screen.getByLabelText("Team ID")).toHaveValue("");
});

test("clears transient creation state when switching to a different Connection", async () => {
  const user = userEvent.setup();
  vi.mocked(createOimConnection).mockResolvedValue(createdConnection());
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    ...setup,
    pendingAuthorizationStepIds: ["app"],
  });

  const { rerender } = render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={setup}
      onConnectionSelected={vi.fn()}
      onChanged={vi.fn()}
    />
  );

  await user.type(screen.getByLabelText("Connection name"), "Support");
  await user.type(screen.getByLabelText("Client ID"), "client-id");
  await user.type(screen.getByLabelText("Client secret"), "client-secret");
  await user.type(screen.getByLabelText("Workspace URL"), "https://workspace.example.test");
  await user.click(screen.getByRole("button", { name: "Create Connection" }));
  expect(
    await screen.findByRole("button", { name: "Continue with Create app" })
  ).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Connection created.");

  rerender(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={{ ...setup, pendingAuthorizationStepIds: ["account"] }}
      connectionId="connection-2"
      onConnectionSelected={vi.fn()}
      onChanged={vi.fn()}
    />
  );

  expect(
    await screen.findByRole("button", { name: "Continue with Authorize account" })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Continue with Create app" })
  ).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});

test("ignores a deferred create result after selecting another Connection", async () => {
  const user = userEvent.setup();
  const createResult = deferred<Awaited<ReturnType<typeof createOimConnection>>>();
  const onConnectionSelected = vi.fn();
  vi.mocked(createOimConnection).mockReturnValue(createResult.promise);

  const { rerender } = render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={setup}
      onConnectionSelected={onConnectionSelected}
      onChanged={vi.fn()}
    />
  );

  await user.type(screen.getByLabelText("Connection name"), "Support");
  await user.type(screen.getByLabelText("Client ID"), "client-id");
  await user.type(screen.getByLabelText("Client secret"), "client-secret");
  await user.type(screen.getByLabelText("Workspace URL"), "https://workspace.example.test");
  await user.click(screen.getByRole("button", { name: "Create Connection" }));

  rerender(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={{ ...setup, pendingAuthorizationStepIds: ["account"] }}
      connectionId="connection-2"
      onConnectionSelected={onConnectionSelected}
      onChanged={vi.fn()}
    />
  );
  expect(
    await screen.findByRole("button", { name: "Continue with Authorize account" })
  ).toBeInTheDocument();

  await act(async () => createResult.resolve(createdConnection()));

  expect(onConnectionSelected).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Continue with Authorize account" })
  ).toBeInTheDocument();
  expect(getOimConnectionSetup).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});

test("ignores a deferred setup failure after selecting another Connection", async () => {
  const user = userEvent.setup();
  const setupResult = deferred<typeof setup>();
  vi.mocked(createOimConnection).mockResolvedValue(createdConnection());
  vi.mocked(getOimConnectionSetup).mockReturnValue(setupResult.promise);

  const { rerender } = render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={setup}
      onConnectionSelected={vi.fn()}
      onChanged={vi.fn()}
    />
  );

  await user.type(screen.getByLabelText("Connection name"), "Support");
  await user.type(screen.getByLabelText("Client ID"), "client-id");
  await user.type(screen.getByLabelText("Client secret"), "client-secret");
  await user.type(screen.getByLabelText("Workspace URL"), "https://workspace.example.test");
  await user.click(screen.getByRole("button", { name: "Create Connection" }));
  await waitFor(() =>
    expect(getOimConnectionSetup).toHaveBeenCalledWith("acme-v2", "connection-1")
  );

  rerender(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={{ ...setup, pendingAuthorizationStepIds: ["account"] }}
      connectionId="connection-2"
      onConnectionSelected={vi.fn()}
      onChanged={vi.fn()}
    />
  );
  await act(async () => setupResult.reject(new Error("Late failure")));

  expect(
    screen.getByRole("button", { name: "Continue with Authorize account" })
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry setup" })).not.toBeInTheDocument();
});

test("does not follow a deferred authorization callback after switching Connections", async () => {
  const user = userEvent.setup();
  const authorizationResult = deferred<{
    action: "redirect";
    url: string;
  }>();
  vi.mocked(startOimConnectionAuthorization).mockReturnValue(authorizationResult.promise);

  const { rerender } = render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={{ ...setup, pendingAuthorizationStepIds: ["app"] }}
      connectionId="connection-1"
      onChanged={vi.fn()}
    />
  );

  await user.click(screen.getByRole("button", { name: "Continue with Create app" }));
  rerender(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={{ ...setup, pendingAuthorizationStepIds: ["account"] }}
      connectionId="connection-2"
      onChanged={vi.fn()}
    />
  );
  await act(async () =>
    authorizationResult.resolve({
      action: "redirect",
      url: "https://provider.example.test/authorize",
    })
  );

  expect(followAuthAction).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Continue with Authorize account" })).toBeEnabled();
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});

test("announces and focuses a completed Connection creation", async () => {
  const user = userEvent.setup();
  vi.mocked(createOimConnection).mockResolvedValue(createdConnection());
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    ...setup,
    pendingAuthorizationStepIds: [],
  });

  render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={setup}
      onConnectionSelected={vi.fn()}
      onChanged={vi.fn()}
    />
  );

  await user.type(screen.getByLabelText("Connection name"), "Support");
  await user.type(screen.getByLabelText("Client ID"), "client-id");
  await user.type(screen.getByLabelText("Client secret"), "client-secret");
  await user.type(screen.getByLabelText("Workspace URL"), "https://workspace.example.test");
  await user.click(screen.getByRole("button", { name: "Create Connection" }));

  const completion = await screen.findByRole("heading", { name: "Connection added" });
  expect(screen.getByRole("status")).toHaveTextContent("Connection added.");
  expect(completion).toHaveFocus();
});

test("resumes the exact Connection after a redirect and keeps every pending step reachable", async () => {
  const user = userEvent.setup();
  vi.mocked(startOimConnectionAuthorization).mockResolvedValue({ action: "pending" });
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    ...setup,
    initialAuthorizationSteps: [
      ...setup.initialAuthorizationSteps,
      { id: "install", title: "Install app", type: "install" as const },
      { id: "webhook", title: "Register webhook", type: "webhook" as const },
    ],
    pendingAuthorizationStepIds: ["install", "webhook"],
  });

  render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={{
        ...setup,
        initialAuthorizationSteps: [
          ...setup.initialAuthorizationSteps,
          { id: "install", title: "Install app", type: "install" as const },
          { id: "webhook", title: "Register webhook", type: "webhook" as const },
        ],
        pendingAuthorizationStepIds: ["install", "webhook"],
      }}
      connectionId="connection-1"
      onChanged={vi.fn()}
    />
  );

  expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue with Install app" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Continue with Register webhook" })
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Continue with Register webhook" }));

  expect(startOimConnectionAuthorization).toHaveBeenCalledWith(
    "acme-v2",
    "connection-1",
    "webhook"
  );
  expect(getOimConnectionSetup).toHaveBeenCalledWith("acme-v2", "connection-1");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Webhook setup is pending provider confirmation."
  );
});

test("keeps a rejected-credential Connection selected and retries verification without another POST", async () => {
  const user = userEvent.setup();
  vi.mocked(createOimConnection).mockResolvedValue({
    connectionId: "connection-1",
    verification: { status: "action_required", error: "provider_proof_failed" },
  });
  vi.mocked(getOimConnectionSetup).mockResolvedValue({
    ...setup,
    connectionHealth: "action_required",
    pendingAuthorizationStepIds: [],
  });
  vi.mocked(refreshOimConnection).mockResolvedValue({
    connectionId: "connection-1",
    health: "healthy",
    steps: [],
  });

  render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={setup}
      onConnectionSelected={vi.fn()}
      onChanged={vi.fn()}
    />
  );

  await user.type(screen.getByLabelText("Connection name"), "Support");
  await user.type(screen.getByLabelText("Client ID"), "client-id");
  await user.type(screen.getByLabelText("Client secret"), "do-not-render");
  await user.type(screen.getByLabelText("Workspace URL"), "https://workspace.example.test");
  await user.click(screen.getByRole("button", { name: "Create Connection" }));

  const repairHeading = await screen.findByRole("heading", {
    name: "Connection needs verification",
  });
  expect(repairHeading).toHaveFocus();
  expect(screen.getByText(/provider rejected the saved credentials/i)).toBeInTheDocument();
  expect(screen.queryByText("do-not-render")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("credentials were rejected");

  await user.click(screen.getByRole("button", { name: "Retry verification" }));

  expect(refreshOimConnection).toHaveBeenCalledWith("acme-v2", "connection-1");
  expect(createOimConnection).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole("heading", { name: "Connection added" })).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent("Connection verified.");
});

test("offers ID-bound persistence recovery after reload", async () => {
  const user = userEvent.setup();
  vi.mocked(refreshOimConnection).mockResolvedValue({
    connectionId: "connection-1",
    health: "action_required",
    steps: [
      {
        stepId: "verification",
        status: "action_required",
        error: "verification_persistence_failed",
      },
    ],
  });

  render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={{
        ...setup,
        connectionHealth: "action_required",
        pendingAuthorizationStepIds: [],
      }}
      connectionId="connection-1"
      onChanged={vi.fn()}
    />
  );

  const repairHeading = screen.getByRole("heading", { name: "Connection needs verification" });
  expect(
    screen.getByText(/verify the saved credentials before this Connection can be used/i)
  ).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("verification needs another try");
  expect(repairHeading).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Retry verification" }));

  expect(refreshOimConnection).toHaveBeenCalledWith("acme-v2", "connection-1");
  expect(screen.getByText(/result could not be saved/i)).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("verification needs another try");
  expect(createOimConnection).not.toHaveBeenCalled();
});

test("ignores a deferred verification result after switching Connections", async () => {
  const user = userEvent.setup();
  const verificationResult = deferred<Awaited<ReturnType<typeof refreshOimConnection>>>();
  vi.mocked(refreshOimConnection).mockReturnValue(verificationResult.promise);

  const { rerender } = render(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={{
        ...setup,
        connectionHealth: "action_required",
        pendingAuthorizationStepIds: [],
      }}
      connectionId="connection-1"
      onChanged={vi.fn()}
    />
  );

  await user.click(screen.getByRole("button", { name: "Retry verification" }));
  rerender(
    <OimConnectionSetup
      integrationKey="acme-v2"
      setup={{ ...setup, connectionHealth: "healthy", pendingAuthorizationStepIds: [] }}
      connectionId="connection-2"
      onChanged={vi.fn()}
    />
  );
  await act(async () =>
    verificationResult.resolve({
      connectionId: "connection-1",
      health: "action_required",
      steps: [
        {
          stepId: "verification",
          status: "action_required",
          error: "verification_unavailable",
        },
      ],
    })
  );

  expect(screen.getByRole("heading", { name: "Connection added" })).toBeInTheDocument();
  expect(screen.queryByText(/provider could not verify/i)).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});
