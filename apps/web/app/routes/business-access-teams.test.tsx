import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { TeamDirectoryEntry } from "~/lib/teams";
import * as session from "~/lib/use-session-user";
import TeamsDirectory from "./_app.business.access.teams";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useRouteError: vi.fn(),
  };
});

vi.mock("~/lib/use-session-user", async () => ({
  ...(await vi.importActual<typeof import("~/lib/use-session-user")>("~/lib/use-session-user")),
  useIsAdmin: vi.fn(),
}));

const EVERYONE_ID = "10000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "10000000-0000-4000-8000-000000000002";

const TEAMS: TeamDirectoryEntry[] = [
  {
    id: EVERYONE_ID,
    businessId: "business",
    slug: "everyone",
    displayName: "Everyone",
    description: "Every person in the company.",
    labels: ["company"],
    status: "active",
    parentTeamId: null,
    revision: 1,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    archivedAt: null,
    members: [{ principalId: "u1", name: "Muskan Vijayvargiya", level: "admin" }],
  },
  {
    id: PRODUCT_ID,
    businessId: "business",
    slug: "product",
    displayName: "Product",
    description: "Builds the product.",
    labels: ["engineering"],
    status: "active",
    parentTeamId: EVERYONE_ID,
    revision: 1,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    archivedAt: null,
    members: [
      { principalId: "u2", name: "Aarav Shah", level: "admin" },
      { principalId: "u3", name: "Meera Rao", level: "member" },
    ],
  },
  {
    id: "10000000-0000-4000-8000-000000000003",
    businessId: "business",
    slug: "platform",
    displayName: "Platform",
    description: "Runs shared infrastructure.",
    labels: ["engineering", "infrastructure"],
    status: "active",
    parentTeamId: PRODUCT_ID,
    revision: 1,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    archivedAt: null,
    members: [{ principalId: "u4", name: "Nila Bose", level: "member" }],
  },
];

function renderPage(teams = TEAMS, isAdmin = true) {
  vi.mocked(remix.useLoaderData).mockReturnValue({ teams });
  vi.mocked(session.useIsAdmin).mockReturnValue(isAdmin);
  const Stub = createRemixStub([{ path: "/", Component: TeamsDirectory }]);
  return render(<Stub initialEntries={["/"]} />);
}

afterEach(() => vi.clearAllMocks());

test("shows one searchable list without access tabs, tree controls, or migration actions", () => {
  renderPage();

  expect(screen.getByRole("list", { name: "Teams" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Tree" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Migration report" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "People" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Platform/ })).toHaveAttribute("href", "/teams/platform");
});

test("renders square gradient avatars without initials", () => {
  const { container } = renderPage();
  const avatars = [...container.querySelectorAll('span[aria-hidden="true"][style]')].filter(
    (element) => element.getAttribute("style")?.includes("gradient")
  );

  expect(avatars).toHaveLength(TEAMS.length);
  expect(avatars.every((avatar) => avatar.textContent === "")).toBe(true);
});

test.each([
  ["platform", "Platform"],
  ["Meera Rao", "Product"],
  ["admin Aarav", "Product"],
  ["infrastructure", "Platform"],
])("searches by %s", async (query, expectedTeam) => {
  renderPage();
  await userEvent.type(screen.getByRole("searchbox", { name: "Search teams" }), query);

  expect(screen.getByRole("link", { name: new RegExp(expectedTeam) })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Showing");
});

test("filters by label and sorts the list", async () => {
  const user = userEvent.setup();
  renderPage();

  await user.click(screen.getByRole("button", { name: "engineering" }));
  expect(screen.queryByText("Everyone")).not.toBeInTheDocument();
  expect(screen.getByText("Product")).toBeInTheDocument();
  expect(screen.getByText("Platform")).toBeInTheDocument();

  await user.selectOptions(screen.getByLabelText("Sort"), "members-asc");
  const rows = screen.getByRole("list", { name: "Teams" }).querySelectorAll(":scope > li");
  expect(Array.from(rows).map((row) => row.textContent)).toEqual([
    expect.stringContaining("Platform"),
    expect.stringContaining("Product"),
  ]);
});

test("shows the create action only to company admins", () => {
  const { unmount } = renderPage(TEAMS, true);
  expect(screen.getByRole("link", { name: "Create Team" })).toHaveAttribute("href", "/teams/new");
  unmount();

  renderPage(TEAMS, false);
  expect(screen.queryByRole("link", { name: "Create Team" })).not.toBeInTheDocument();
});

test("shows useful empty and no-match states", async () => {
  const { unmount } = renderPage([]);
  expect(screen.getByText("Build your first Team")).toBeInTheDocument();
  unmount();

  renderPage();
  await userEvent.type(screen.getByRole("searchbox", { name: "Search teams" }), "missing");
  expect(screen.getByText("No Teams found")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
});
