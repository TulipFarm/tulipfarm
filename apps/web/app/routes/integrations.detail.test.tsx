import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";

/*
 * Connecting, disconnecting and removing an integration seal or revoke the deployment-wide
 * provider credential, so the API refuses a non-admin. The page has to agree: offering a control
 * the server will 403 teaches people the product is broken rather than that they lack authority.
 */
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
}));

import type { IntegrationDetail } from "~/lib/integrations";
import { deleteIntegration, disconnectIntegration } from "~/lib/integrations";
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
    // The page reads nothing out of the raw manifest any more — connect steps arrive resolved as
    // `auth`, and the old type/transport readout is gone.
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
  // Every URL, log line, and manifest calls it by the slug — losing it strands anyone
  // cross-referencing the page against a config file. It appears once, next to the brand name,
  // rather than being repeated in the breadcrumb.
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
  // A bot-token integration like Telegram grants nothing enumerable. An empty "Access you grant"
  // panel would imply the answer is unknown rather than none.
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

  // Nothing destructive is reachable in one click from a page people come to in order to connect.
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

/*
 * The member's view of the same page. These pin the boundary the API now enforces on
 * `POST /integrations/:name/connect|disconnect`, `DELETE /integrations/:name`, and GitHub's
 * installation-disconnect and Soul-repo routes: everything that reads stays, everything that
 * writes the connection goes. A member still needs this page — it is where they learn what the
 * integration reaches and whether it is connected at all.
 */
test("offers a member no way to connect, and says why instead", async () => {
  admin = false;
  renderDetail(
    detail({
      connected: false,
      auth: [{ index: 0, kind: "fields", satisfied: false, producesEnv: true, fields: [] }],
    })
  );
  await screen.findByRole("heading", { level: 1 });

  // The heading stays, so the section is not silently missing — only its controls are.
  expect(screen.getByText(/^connect$/i)).toBeInTheDocument();
  expect(await screen.findByText(/an admin has to do it/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^continue$/i })).not.toBeInTheDocument();
});

test("hides disconnect and remove from a member", async () => {
  admin = false;
  renderDetail(detail({ connected: true, status: "connected" }));
  await screen.findByRole("heading", { level: 1 });

  expect(screen.queryByRole("button", { name: /disconnect/i })).not.toBeInTheDocument();
  // The overflow menu holds only the destructive action, so it goes with it rather than opening
  // onto nothing.
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
