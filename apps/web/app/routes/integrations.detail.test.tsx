import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";

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
});

vi.mock("~/lib/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/integrations")>()),
  deleteIntegration: vi.fn(),
  disconnectIntegration: vi.fn(),
  disconnectGitHubInstallation: vi.fn(),
  disconnectPersonalIntegration: vi.fn(),
  updateIntegration: vi.fn(),
}));

import type { IntegrationDetail } from "~/lib/integrations";
import { deleteIntegration, disconnectIntegration, updateIntegration } from "~/lib/integrations";
import IntegrationDetailPage from "./_app.integrations.$name";

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

function renderDetail(integration: IntegrationDetail) {
  const Stub = createRemixStub([
    {
      path: "/integrations/:name",
      Component: () => <IntegrationDetailPage />,
      loader: () => ({ integration, routesError: undefined, githubInstallations: [] }),
    },
    { path: "/integrations", Component: () => <p>catalog</p> },
  ]);
  render(<Stub initialEntries={["/integrations/github"]} />);
}

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
