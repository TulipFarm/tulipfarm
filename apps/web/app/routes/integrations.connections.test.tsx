import * as remix from "@remix-run/react";
import { render, screen, waitFor } from "@testing-library/react";
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
  };
});

vi.mock("~/lib/use-session-user", () => ({
  useIsAdmin: () => true,
}));

vi.mock("~/lib/integrations", async () => {
  const actual = await vi.importActual<typeof import("~/lib/integrations")>("~/lib/integrations");
  return {
    ...actual,
    createOimConnection: vi.fn().mockResolvedValue({ connectionId: "c1", scope: "personal" }),
    revokeOimConnection: vi.fn().mockResolvedValue(undefined),
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
  await userEvent.selectOptions(screen.getByLabelText("Used by"), "team");
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
    })
  );
});

test("refuses to offer a form for a sign-in flow this deployment cannot run", () => {
  load({ form: { ...form, unsupportedStepTypes: ["oauth2"] } });
  render(<IntegrationConnections />);

  expect(screen.getByText(/signs in with oauth2/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
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
