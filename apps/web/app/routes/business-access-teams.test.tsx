import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import {
  type AuthzGroupDetail,
  type AuthzRole,
  addGroupMember,
  createGroup,
  deleteGroup,
  grantRoleToGroup,
  removeGroupMember,
  revokeRoleFromGroup,
} from "~/lib/authz";
import type { UserSummary } from "~/lib/users";
import AccessTeams from "./_app.business.access.teams";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useRevalidator: vi.fn(() => ({ revalidate: vi.fn(), state: "idle" })),
    useRouteError: vi.fn(),
  };
});

vi.mock("~/lib/authz", async () => ({
  ...(await vi.importActual<typeof import("~/lib/authz")>("~/lib/authz")),
  addGroupMember: vi.fn().mockResolvedValue({ status: "ok" }),
  createGroup: vi.fn().mockResolvedValue({ status: "ok" }),
  deleteGroup: vi.fn().mockResolvedValue(undefined),
  getGroup: vi.fn(),
  grantRoleToGroup: vi.fn().mockResolvedValue({ status: "ok" }),
  listGroups: vi.fn(),
  listRoles: vi.fn(),
  removeGroupMember: vi.fn().mockResolvedValue(undefined),
  revokeRoleFromGroup: vi.fn().mockResolvedValue(undefined),
}));

const PRIYA_ID = "0b925e15-881b-4f76-ac0d-f5d6e4f41b40";
const RAHUL_ID = "6c1f0a2e-1111-4222-8333-944455556666";
const MINA_ID = "7604e4f8-a5dc-4e81-a89c-4200d7ec4c22";

const ROLES: AuthzRole[] = [
  {
    id: "member",
    source: "builtin",
    displayName: null,
    slug: null,
    assignableTo: ["user"],
    parentRoleIds: [],
    expiresAt: null,
    grants: [{ effect: "allow", action: "*", resourceType: "chat", label: "allow any on chat" }],
  },
  {
    id: "admin",
    source: "builtin",
    displayName: null,
    slug: null,
    assignableTo: ["user"],
    parentRoleIds: [],
    expiresAt: null,
    grants: [{ effect: "allow", action: "*", resourceType: "*", label: "allow any on any" }],
  },
  {
    id: "bot-tools",
    source: "authored",
    displayName: null,
    slug: null,
    assignableTo: ["agent"],
    parentRoleIds: [],
    expiresAt: null,
    grants: [
      {
        effect: "allow",
        action: "*",
        resourceType: "platform.task",
        label: "allow any on platform.task",
      },
    ],
  },
  {
    id: "support-operators",
    source: "authored",
    displayName: null,
    slug: null,
    assignableTo: ["user"],
    parentRoleIds: [],
    expiresAt: null,
    grants: [
      {
        effect: "allow",
        action: "record.read",
        resourceType: "record.customer",
        label: "allow record.read on record.customer",
      },
    ],
  },
  {
    id: "accounts-team",
    source: "authored",
    displayName: null,
    slug: null,
    assignableTo: ["user"],
    parentRoleIds: [],
    expiresAt: null,
    grants: [
      {
        effect: "allow",
        action: "record.update",
        resourceType: "record.invoice",
        label: "allow record.update on record.invoice",
      },
    ],
  },
];

const USERS: UserSummary[] = [
  {
    id: PRIYA_ID,
    email: "priya@cafe.test",
    name: "Priya Sharma",
    role: "member",
    status: "active",
  },
  { id: RAHUL_ID, email: "rahul@cafe.test", name: null, role: "member", status: "active" },
  { id: MINA_ID, email: "mina@cafe.test", name: "Mina Patel", role: "member", status: "active" },
];

const TEAMS: AuthzGroupDetail[] = [
  {
    id: "front-of-house",
    expiresAt: null,
    members: [{ principalId: PRIYA_ID, expiresAt: null }],
    roles: [{ roleId: "support-operators", expiresAt: null }],
  },
  {
    id: "kitchen",
    expiresAt: null,
    members: [],
    roles: [],
  },
  {
    id: "accounts",
    expiresAt: null,
    members: [
      { principalId: RAHUL_ID, expiresAt: null },
      { principalId: MINA_ID, expiresAt: null },
    ],
    roles: [{ roleId: "accounts-team", expiresAt: null }],
  },
];

type LoaderData = {
  teams: AuthzGroupDetail[];
  roles: AuthzRole[];
  users: UserSummary[];
};

function loaderData(overrides: Partial<LoaderData> = {}): LoaderData {
  return {
    teams: TEAMS,
    roles: ROLES,
    users: USERS,
    ...overrides,
  };
}

function renderPage(data: LoaderData = loaderData()) {
  vi.mocked(remix.useLoaderData).mockReturnValue(data);
  const Stub = createRemixStub([{ path: "/", Component: AccessTeams }]);
  render(<Stub initialEntries={["/"]} />);
}

async function openTeam(name: string, data: LoaderData = loaderData()) {
  const user = userEvent.setup();
  renderPage(data);
  await user.click(screen.getByRole("button", { name: new RegExp(name, "i") }));
  expect(screen.getByRole("heading", { name: `${name} team` })).toBeInTheDocument();
  return user;
}

function teamRows(): HTMLElement[] {
  return screen.getAllByRole("button", { name: /Open team/ });
}

function formForControl(control: HTMLElement): HTMLElement {
  const form = control.closest("form");
  if (!form) throw new Error("Expected control to be inside a form");
  return form;
}

afterEach(() => {
  vi.clearAllMocks();
});

test("titles a team from its slug and lists its people by name in the sheet", async () => {
  await openTeam("Front of house");

  expect(screen.getByText("Priya Sharma")).toBeInTheDocument();
  expect(screen.queryByText(PRIYA_ID)).not.toBeInTheDocument();
});

test("says what membership actually buys, in plain words", async () => {
  await openTeam("Front of house");
  expect(screen.getByText("View Customer records")).toBeInTheDocument();
});

test("derives the identifier from a typed name instead of asking for one", async () => {
  const user = userEvent.setup();
  renderPage();

  expect(screen.queryByLabelText(/Group ID/)).not.toBeInTheDocument();

  await user.type(screen.getByLabelText(/Team name/), "Kitchen Staff");
  expect(screen.getByText(/Saved as “kitchen-staff”/)).toBeInTheDocument();
});

test("refuses a name that would collide with an existing team", async () => {
  const user = userEvent.setup();
  renderPage();

  await user.type(screen.getByLabelText(/Team name/), "Front of house");
  expect(screen.getByText("A team with that name already exists.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create team" })).toBeDisabled();
});

test("creates a team under the derived slug", async () => {
  const user = userEvent.setup();
  renderPage();

  await user.type(screen.getByLabelText(/Team name/), "Kitchen Staff");
  await user.click(screen.getByRole("button", { name: "Create team" }));

  await waitFor(() => expect(createGroup).toHaveBeenCalledWith("kitchen-staff"));
});

test("searches by team name, member name, and email", async () => {
  const user = userEvent.setup();
  renderPage();

  const search = screen.getByLabelText("Search teams");

  await user.type(search, "kitch");
  expect(teamRows()).toHaveLength(1);
  expect(teamRows()[0]).toHaveTextContent("Kitchen");

  await user.clear(search);
  await user.type(search, "Priya");
  expect(teamRows()).toHaveLength(1);
  expect(teamRows()[0]).toHaveTextContent("Front of house");

  await user.clear(search);
  await user.type(search, "rahul@cafe.test");
  expect(teamRows()).toHaveLength(1);
  expect(teamRows()[0]).toHaveTextContent("Accounts");
  expect(screen.getByText("Showing 1 of 3 teams.")).toBeInTheDocument();
});

test("sorts teams by name and member count", async () => {
  const user = userEvent.setup();
  renderPage();

  expect(teamRows().map((row) => row.textContent)).toEqual([
    expect.stringContaining("Accounts"),
    expect.stringContaining("Front of house"),
    expect.stringContaining("Kitchen"),
  ]);

  await user.selectOptions(screen.getByLabelText("Sort teams"), "name-desc");
  expect(teamRows().map((row) => row.textContent)).toEqual([
    expect.stringContaining("Kitchen"),
    expect.stringContaining("Front of house"),
    expect.stringContaining("Accounts"),
  ]);

  await user.selectOptions(screen.getByLabelText("Sort teams"), "members-desc");
  expect(teamRows().map((row) => row.textContent)).toEqual([
    expect.stringContaining("Accounts"),
    expect.stringContaining("Front of house"),
    expect.stringContaining("Kitchen"),
  ]);

  await user.selectOptions(screen.getByLabelText("Sort teams"), "members-asc");
  expect(teamRows().map((row) => row.textContent)).toEqual([
    expect.stringContaining("Kitchen"),
    expect.stringContaining("Front of house"),
    expect.stringContaining("Accounts"),
  ]);
});

test("filters teams that have no access yet", async () => {
  const user = userEvent.setup();
  renderPage();

  await user.selectOptions(screen.getByLabelText("Filter teams"), "no-access");

  expect(teamRows()).toHaveLength(1);
  expect(teamRows()[0]).toHaveTextContent("Kitchen");
  expect(teamRows()[0]).toHaveTextContent("No access yet.");
});

test("filters teams that have nobody in them", async () => {
  const user = userEvent.setup();
  renderPage();

  await user.selectOptions(screen.getByLabelText("Filter teams"), "empty");

  expect(teamRows()).toHaveLength(1);
  expect(teamRows()[0]).toHaveTextContent("Kitchen");
  expect(teamRows()[0]).toHaveTextContent("Nobody");
});

test("shows an empty state with a clear action when nothing matches", async () => {
  const user = userEvent.setup();
  renderPage();

  await user.type(screen.getByLabelText("Search teams"), "zzzz");

  expect(screen.getByText(/No teams match that search or filter/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Clear it" }));
  expect(screen.getByLabelText("Search teams")).toHaveValue("");
  expect(teamRows()).toHaveLength(3);
});

test("clicking a row opens the right side sheet", async () => {
  await openTeam("Accounts");

  expect(screen.getByText("Everyone in this team can")).toBeInTheDocument();
  expect(screen.getByText("People in this team")).toBeInTheDocument();
});

test("adds a person from a picker of real accounts, excluding current members", async () => {
  const user = await openTeam("Front of house");

  const picker = screen.getByLabelText("Add someone");
  const options = within(picker)
    .getAllByRole("option")
    .map((option) => option.textContent);
  expect(options).toContain("rahul@cafe.test");
  expect(options).not.toContain("Priya Sharma, priya@cafe.test");

  await user.selectOptions(picker, RAHUL_ID);
  await user.click(within(formForControl(picker)).getByRole("button", { name: "Add" }));

  await waitFor(() => expect(addGroupMember).toHaveBeenCalledWith("front-of-house", RAHUL_ID));
});

test("grants access from the sheet", async () => {
  const user = await openTeam("Kitchen");
  const picker = screen.getByLabelText("Give this team more access");

  await user.selectOptions(picker, "support-operators");
  await user.click(within(formForControl(picker)).getByRole("button", { name: "Add" }));

  await waitFor(() =>
    expect(grantRoleToGroup).toHaveBeenCalledWith("kitchen", "support-operators")
  );
});

test("takes access away only after a confirmation step", async () => {
  const user = await openTeam("Front of house");

  await user.click(screen.getByRole("button", { name: "Take away" }));
  expect(revokeRoleFromGroup).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Yes, take it away" }));
  await waitFor(() =>
    expect(revokeRoleFromGroup).toHaveBeenCalledWith("front-of-house", "support-operators")
  );
});

test("never offers the account-derived Roles as team access", async () => {
  const user = await openTeam("Kitchen");

  const picker = screen.getByLabelText("Give this team more access");
  const options = within(picker)
    .getAllByRole("option")
    .map((option) => option.textContent);
  expect(options).not.toContain("Everyday access");
  expect(options).not.toContain("Full access");
  expect(options).toContain("Support operators");

  await user.selectOptions(picker, "support-operators");
  expect(picker).toHaveValue("support-operators");
});

test("removes a person only after a confirmation step", async () => {
  const user = await openTeam("Front of house");

  await user.click(screen.getByRole("button", { name: "Remove" }));
  expect(removeGroupMember).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Yes, remove" }));
  await waitFor(() => expect(removeGroupMember).toHaveBeenCalledWith("front-of-house", PRIYA_ID));
});

/* Deleting a team must name how many members lose inherited access. */
test("names the blast radius before deleting a team", async () => {
  const user = await openTeam("Front of house");

  await user.click(screen.getByRole("button", { name: "Delete team" }));
  expect(deleteGroup).not.toHaveBeenCalled();

  const confirm = screen.getByRole("button", {
    name: "Yes, delete and remove access for 1",
  });
  await user.click(confirm);
  await waitFor(() => expect(deleteGroup).toHaveBeenCalledWith("front-of-house"));
});

test("tells an owner teams are optional rather than showing a bare empty list", () => {
  renderPage(loaderData({ teams: [] }));
  expect(screen.getByText(/You do not need one/)).toBeInTheDocument();
});

/* Team assignments must be valid for every member or the authority layer fails closed. */
test("does not offer a team a Role that a person may not hold", async () => {
  await openTeam("Kitchen");

  const options = within(screen.getByLabelText("Give this team more access"))
    .getAllByRole("option")
    .map((option) => option.textContent);
  expect(options).not.toContain("Bot tools");
  expect(options).toContain("Support operators");
});
