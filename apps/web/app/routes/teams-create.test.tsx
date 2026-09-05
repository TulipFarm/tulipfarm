import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as teamsApi from "~/lib/teams";
import * as session from "~/lib/use-session-user";
import CreateTeamRoute from "./_app.business.access.teams.new";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn(), useRouteError: vi.fn() };
});

vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: vi.fn() }));
vi.mock("~/lib/teams", async () => {
  const actual = await vi.importActual<typeof import("~/lib/teams")>("~/lib/teams");
  return { ...actual, createTeam: vi.fn() };
});

const EVERYONE = {
  id: "10000000-0000-4000-8000-000000000001",
  businessId: "business",
  slug: "everyone",
  displayName: "Everyone",
  description: null,
  status: "active" as const,
  parentTeamId: null,
  revision: 1,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  archivedAt: null,
  members: [],
};

const EXISTING = {
  ...EVERYONE,
  id: "10000000-0000-4000-8000-000000000002",
  slug: "product-design",
  displayName: "Product Design",
  parentTeamId: EVERYONE.id,
};

const USERS = [
  {
    id: "creator",
    email: "creator@example.com",
    name: "Creator Person",
    role: "admin" as const,
    status: "active" as const,
  },
  {
    id: "admin",
    email: "admin@example.com",
    name: "Muskan Vijayvargiya",
    role: "member" as const,
    status: "active" as const,
  },
];

function renderPage(teams = [EVERYONE, EXISTING]) {
  vi.mocked(remix.useLoaderData).mockReturnValue({ teams, users: USERS });
  const Stub = createRemixStub([
    { path: "/teams/new", Component: CreateTeamRoute },
    { path: "/teams/:slug", Component: () => <p>Created</p> },
  ]);
  return render(<Stub initialEntries={["/teams/new"]} />);
}

beforeEach(() => {
  vi.mocked(session.useIsAdmin).mockReturnValue(true);
  vi.mocked(teamsApi.createTeam).mockResolvedValue({
    ...EXISTING,
    id: "10000000-0000-4000-8000-000000000003",
    slug: "customer-success",
    displayName: "Customer Success",
  });
});
afterEach(() => vi.clearAllMocks());

test("creates a Team with a generated immutable slug and selected human admin", async () => {
  const user = userEvent.setup();
  renderPage();

  expect(screen.getByLabelText("Creator Person")).not.toBeChecked();
  expect(screen.getByText("The creator is not selected automatically.")).toBeInTheDocument();

  await user.type(screen.getByLabelText(/Display name/), "Customer Success");
  expect(screen.getByText("customer-success")).toBeInTheDocument();
  await user.click(screen.getByLabelText("Muskan Vijayvargiya"));
  await user.type(screen.getByLabelText("Description"), "Helps customers succeed.");
  await user.type(screen.getByLabelText("Labels"), " Support, Customer-facing, support ");
  await user.click(screen.getByRole("button", { name: "Create Team" }));

  expect(teamsApi.createTeam).toHaveBeenCalledWith({
    displayName: "Customer Success",
    slug: "customer-success",
    parentTeamId: EVERYONE.id,
    description: "Helps customers succeed.",
    labels: ["support", "customer-facing"],
    initialAdminUserIds: ["admin"],
  });
  expect(await screen.findByText("Created")).toBeInTheDocument();
});

test("explains sibling display-name and business slug conflicts before submit", async () => {
  renderPage();
  await userEvent.type(screen.getByLabelText(/Display name/), "Product Design");

  expect(screen.getByText("A sibling Team already uses this display name.")).toBeInTheDocument();
  expect(
    screen.getByText("This business already uses or reserved this Team slug.")
  ).toBeInTheDocument();
});

test("requires at least one initial human Team admin", async () => {
  renderPage();
  await userEvent.type(screen.getByLabelText(/Display name/), "Operations");
  await userEvent.click(screen.getByRole("button", { name: "Create Team" }));

  expect(screen.getByText("Select at least one human Team admin.")).toBeInTheDocument();
  expect(teamsApi.createTeam).not.toHaveBeenCalled();
});

test("does not show Team creation controls to a non-admin", () => {
  vi.mocked(session.useIsAdmin).mockReturnValue(false);
  renderPage();

  expect(screen.getByRole("alert")).toHaveTextContent("Only a company admin can create a Team.");
  expect(screen.queryByRole("button", { name: "Create Team" })).not.toBeInTheDocument();
});
