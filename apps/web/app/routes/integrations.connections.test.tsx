import * as remix from "@remix-run/react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { OimConnectForm, OimConnectionSummary } from "~/lib/integrations";
import * as integrations from "~/lib/integrations";
import IntegrationConnections from "./_app.business.integrations.$slug.connections";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useRouteError: vi.fn(),
    useRevalidator: vi.fn(() => ({ revalidate: vi.fn(), state: "idle" })),
    useSearchParams: vi.fn(() => [new URLSearchParams(), vi.fn()]),
  };
});

vi.mock("~/lib/use-session-user", () => ({
  useIsAdmin: () => true,
}));

vi.mock("~/lib/integrations", async () => {
  const actual = await vi.importActual<typeof import("~/lib/integrations")>("~/lib/integrations");
  return {
    ...actual,
    createOimConnection: vi
      .fn()
      .mockResolvedValue({ connectionId: "c1", scope: "personal", status: "active" }),
    approveOimConnectionOrigin: vi.fn(),
    revokeOimConnection: vi.fn().mockResolvedValue(undefined),
    updateOimConnection: vi.fn().mockResolvedValue({
      id: "c1",
      label: "Connection",
      scope: "personal",
      status: "active",
      isDefault: false,
      health: "healthy",
      expiresAt: null,
      configuration: {},
    }),
    authorizeOimConnection: vi.fn(),
  };
});

afterEach(() => vi.clearAllMocks());

const form: OimConnectForm = {
  integrationId: "jira",
  majorVersion: 1,
  steps: [
    {
      id: "token",
      title: "Create an API token",
      fields: [
        { id: "email", label: "Account email", input: "text", required: true, secret: false },
        { id: "token", label: "API token", input: "password", required: true, secret: true },
      ],
    },
  ],
  authorizationSteps: [],
  unsupportedStepTypes: [],
  requiresAuthorization: false,
};

function load(overrides: {
  form?: OimConnectForm;
  connections?: OimConnectionSummary[];
  teams?: Array<{ id: string; displayName: string }>;
}): void {
  vi.mocked(remix.useLoaderData).mockReturnValue({
    slug: "jira",
    form: overrides.form ?? form,
    connections: overrides.connections ?? [],
    teams: overrides.teams ?? [],
  });
}

test("renders one input per declared field and masks the credential", () => {
  load({});
  render(<IntegrationConnections />);

  expect(screen.getByLabelText(/Account email/)).toHaveAttribute("type", "text");
  expect(screen.getByLabelText(/API token/)).toHaveAttribute("type", "password");
});

test("submits a selected Team id with a Team connection", async () => {
  load({ teams: [{ id: "00000000-0000-4000-8000-000000000004", displayName: "Support" }] });
  render(<IntegrationConnections />);

  await userEvent.type(screen.getByLabelText(/^Name/), "Support desk");
  await userEvent.click(screen.getByRole("radio", { name: "One Team" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Team" }));
  await userEvent.keyboard("[ArrowDown][Enter]");
  await userEvent.type(screen.getByLabelText(/Account email/), "ops@acme.test");
  await userEvent.type(screen.getByLabelText(/API token/), "t0ken");
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));

  await waitFor(() =>
    expect(integrations.createOimConnection).toHaveBeenCalledWith("jira", {
      label: "Support desk",
      scope: "team",
      teamId: "00000000-0000-4000-8000-000000000004",
      values: { email: "ops@acme.test", token: "t0ken" },
      isDefault: true,
    })
  );
});

test("submits the declared values under the chosen scope", async () => {
  load({});
  render(<IntegrationConnections />);

  await userEvent.type(screen.getByLabelText(/^Name/), "Support desk");
  await userEvent.type(screen.getByLabelText(/Account email/), "ops@acme.test");
  await userEvent.type(screen.getByLabelText(/API token/), "t0ken");
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));

  await waitFor(() =>
    expect(integrations.createOimConnection).toHaveBeenCalledWith("jira", {
      label: "Support desk",
      scope: "personal",
      values: { email: "ops@acme.test", token: "t0ken" },
      isDefault: true,
    })
  );
});

test("supports an OAuth-only Connection without pretending the save finished setup", async () => {
  vi.mocked(integrations.createOimConnection).mockResolvedValue({
    connectionId: "c1",
    scope: "personal",
    status: "pending",
  });
  vi.mocked(integrations.authorizeOimConnection).mockRejectedValue(
    new Error("Provider handoff unavailable")
  );
  load({
    form: {
      ...form,
      steps: [],
      authorizationSteps: [{ id: "oauth", type: "oauth2", title: "Authorize Jira" }],
      requiresAuthorization: true,
    },
  });
  render(<IntegrationConnections />);

  expect(screen.getByText("Authorize Jira")).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText(/^Name/), "Support desk");
  await userEvent.click(screen.getByRole("button", { name: "Save and continue" }));

  await waitFor(() =>
    expect(integrations.createOimConnection).toHaveBeenCalledWith("jira", {
      label: "Support desk",
      scope: "personal",
      values: {},
      isDefault: true,
    })
  );
  expect(integrations.authorizeOimConnection).toHaveBeenCalledWith("jira", "c1", {
    stepId: "oauth",
  });
  expect(screen.queryByText(/^Connected\./)).not.toBeInTheDocument();
});

test("keeps an origin-only pending Connection in-page instead of calling browser authorization", async () => {
  vi.mocked(integrations.createOimConnection).mockResolvedValue({
    connectionId: "c1",
    scope: "personal",
    status: "pending",
  });
  load({
    form: {
      ...form,
      steps: [
        {
          id: "site",
          title: "Choose a site",
          fields: [
            {
              id: "baseUrl",
              label: "Site URL",
              input: "url",
              required: true,
              secret: false,
              requiresOriginApproval: true,
            },
          ],
        },
      ],
    },
  });
  render(<IntegrationConnections />);

  expect(
    screen.getByText(/approve the exact public HTTPS origin before Agents can use it/i)
  ).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText(/^Name/), "Internal wiki");
  await userEvent.type(screen.getByLabelText(/Site URL/), "https://wiki.example.test");
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));

  await waitFor(() => expect(integrations.createOimConnection).toHaveBeenCalled());
  expect(integrations.authorizeOimConnection).not.toHaveBeenCalled();
  expect(screen.getByText(/Approve its exact public HTTPS origin/)).toBeInTheDocument();
});

test("approves only the exact stored origin without sending it in the request", async () => {
  vi.mocked(integrations.approveOimConnectionOrigin).mockResolvedValue({
    id: "selfhost-1",
    label: "Internal wiki",
    scope: "organization",
    status: "active",
    isDefault: true,
    health: "unknown",
    expiresAt: null,
    configuration: { baseUrl: "wiki.example.test" },
  });
  load({
    form: {
      ...form,
      steps: [
        {
          id: "site",
          title: "Choose a site",
          fields: [
            {
              id: "baseUrl",
              label: "Site URL",
              input: "url",
              required: true,
              secret: false,
              requiresOriginApproval: true,
            },
          ],
        },
      ],
    },
    connections: [
      {
        id: "selfhost-1",
        label: "Internal wiki",
        scope: "organization",
        status: "pending",
        isDefault: true,
        health: "action_required",
        expiresAt: null,
        configuration: { baseUrl: "wiki.example.test" },
      },
    ],
  });
  render(<IntegrationConnections />);

  expect(screen.getByText("https://wiki.example.test")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Approve https://wiki.example.test" }));

  await waitFor(() =>
    expect(integrations.approveOimConnectionOrigin).toHaveBeenCalledWith(
      "jira",
      "selfhost-1",
      "baseUrl"
    )
  );
  expect(screen.queryByText("https://wiki.example.test")).not.toBeInTheDocument();
});

test("lists existing connections and revokes one", async () => {
  load({
    teams: [{ id: "00000000-0000-4000-8000-000000000004", displayName: "Support" }],
    connections: [
      {
        id: "c1",
        label: "Shared bot",
        scope: "team",
        teamId: "00000000-0000-4000-8000-000000000004",
        status: "active",
        isDefault: true,
        health: "healthy",
        expiresAt: null,
        configuration: { site: "acme.atlassian.net" },
      },
    ],
  });
  render(<IntegrationConnections />);

  expect(screen.getByText("Shared bot")).toBeInTheDocument();
  expect(screen.getByText("Support")).toBeInTheDocument();
  expect(screen.getByText(/site: acme.atlassian.net/)).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(integrations.revokeOimConnection).toHaveBeenCalledWith("jira", "c1"));
});

test("names Connections that expire soon or need reconnection", () => {
  load({
    connections: [
      {
        id: "expiring",
        label: "Expiring bot",
        scope: "organization",
        status: "active",
        isDefault: true,
        health: "expiring",
        expiresAt: "2026-09-05T12:05:00.000Z",
        configuration: {},
      },
      {
        id: "reconnect",
        label: "Reconnect bot",
        scope: "organization",
        status: "active",
        isDefault: false,
        health: "action_required",
        expiresAt: "2026-09-05T12:05:00.000Z",
        configuration: {},
      },
    ],
  });
  render(<IntegrationConnections />);

  expect(screen.getByText("Expires soon")).toBeInTheDocument();
  expect(screen.getByText("Reconnect needed")).toBeInTheDocument();
});

test("rotates submitted credential fields without reading old values", async () => {
  load({
    connections: [
      {
        id: "c1",
        label: "Shared bot",
        scope: "organization",
        status: "active",
        isDefault: false,
        health: "healthy",
        expiresAt: null,
        configuration: {},
      },
    ],
  });
  render(<IntegrationConnections />);

  await userEvent.click(screen.getByRole("button", { name: "Rotate credentials" }));
  const save = screen.getByRole("button", { name: "Save new values" });
  const rotateForm = save.closest("form") as HTMLFormElement;
  expect(within(rotateForm).getByLabelText(/API token/)).toHaveValue("");
  await userEvent.type(within(rotateForm).getByLabelText(/API token/), "new-token");
  await userEvent.click(save);

  await waitFor(() =>
    expect(integrations.updateOimConnection).toHaveBeenCalledWith("jira", "c1", {
      values: { token: "new-token" },
    })
  );
});

test("changes the default explicitly", async () => {
  load({
    connections: [
      {
        id: "c1",
        label: "Personal",
        scope: "personal",
        status: "active",
        isDefault: false,
        health: "healthy",
        expiresAt: null,
        configuration: {},
      },
    ],
  });
  render(<IntegrationConnections />);

  await userEvent.click(screen.getByRole("checkbox", { name: "Default" }));
  await waitFor(() =>
    expect(integrations.updateOimConnection).toHaveBeenCalledWith("jira", "c1", {
      isDefault: true,
    })
  );
});

test("rebinds access and refreshes the list containing the replacement Connection", async () => {
  const revalidate = vi.fn();
  vi.mocked(remix.useRevalidator).mockReturnValueOnce({ revalidate, state: "idle" });
  vi.mocked(integrations.updateOimConnection).mockResolvedValueOnce({
    id: "c2",
    label: "Personal",
    scope: "team",
    teamId: "00000000-0000-4000-8000-000000000004",
    status: "active",
    isDefault: false,
    health: "healthy",
    expiresAt: null,
    configuration: {},
  });
  load({
    teams: [{ id: "00000000-0000-4000-8000-000000000004", displayName: "Support" }],
    connections: [
      {
        id: "c1",
        label: "Personal",
        scope: "personal",
        status: "active",
        isDefault: false,
        health: "healthy",
        expiresAt: null,
        configuration: {},
      },
    ],
  });
  render(<IntegrationConnections />);

  await userEvent.click(screen.getByRole("button", { name: "Change access" }));
  const save = screen.getByRole("button", { name: "Save access" });
  const accessForm = save.closest("form") as HTMLFormElement;
  await userEvent.click(within(accessForm).getByRole("radio", { name: "One Team" }));
  await userEvent.click(within(accessForm).getByRole("combobox", { name: "Team" }));
  await userEvent.keyboard("[ArrowDown][Enter]");
  await userEvent.click(save);

  await waitFor(() =>
    expect(integrations.updateOimConnection).toHaveBeenCalledWith("jira", "c1", {
      scope: "team",
      teamId: "00000000-0000-4000-8000-000000000004",
    })
  );
  expect(revalidate).toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(integrations.revokeOimConnection).toHaveBeenCalledWith("jira", "c2"));
});

test("treats a pending provider callback as progress, not a completed Connection", () => {
  const setSearchParams = vi.fn();
  vi.mocked(remix.useSearchParams).mockReturnValueOnce([
    new URLSearchParams("status=pending&nextStepId=install"),
    setSearchParams,
  ]);
  load({});
  render(<IntegrationConnections />);

  expect(
    screen.getByText(
      "Provider step completed. Continue setup if this Connection still needs authorization."
    )
  ).toBeInTheDocument();
  expect(screen.queryByText(/^Connected\./)).not.toBeInTheDocument();
  const update = setSearchParams.mock.calls[0]?.[0] as (
    current: URLSearchParams
  ) => URLSearchParams;
  expect(update(new URLSearchParams("status=pending&nextStepId=install")).toString()).toBe("");
});
