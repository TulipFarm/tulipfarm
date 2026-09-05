import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { assignRole, revokeRole } from "~/lib/authz";
import { createUser, reissueInvite, setUserStatus } from "~/lib/users";
import AccessPeople from "./_app.business.access._index";

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
  assignRole: vi.fn().mockResolvedValue({ status: "ok" }),
  revokeRole: vi.fn().mockResolvedValue(undefined),
  getEffectiveGrants: vi.fn(),
  getGroup: vi.fn(),
  listGroups: vi.fn(),
  listRoleAssignees: vi.fn(),
  listRoles: vi.fn(),
}));

vi.mock("~/lib/users", async () => ({
  ...(await vi.importActual<typeof import("~/lib/users")>("~/lib/users")),
  listUsers: vi.fn(),
  createUser: vi.fn(),
  reissueInvite: vi.fn(),
  setUserStatus: vi.fn(),
}));

vi.mock("~/lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(true) }));

let sessionUserId = "someone-else";
vi.mock("~/lib/use-session-user", () => ({
  useSessionUser: () => ({
    id: sessionUserId,
    email: "owner@cafe.test",
    name: "Owner",
    role: "admin",
    status: "active",
  }),
  useIsAdmin: () => true,
}));

const PRIYA_ID = "0b925e15-881b-4f76-ac0d-f5d6e4f41b40";
const RAHUL_ID = "6c1f0a2e-1111-4222-8333-944455556666";

const ROLES = [
  {
    id: "admin",
    source: "builtin",
    assignableTo: ["user"],
    parentRoleIds: [],
    expiresAt: null,
    grants: [
      {
        effect: "allow",
        action: "*",
        resourceType: "*",
        label: "allow any action on any resource",
      },
    ],
  },
  {
    id: "member",
    source: "builtin",
    assignableTo: ["user"],
    parentRoleIds: [],
    expiresAt: null,
    grants: [{ effect: "allow", action: "*", resourceType: "chat", label: "allow any on chat" }],
  },
  {
    id: "owner",
    source: "builtin",
    assignableTo: ["user"],
    parentRoleIds: [],
    expiresAt: null,
    grants: [
      {
        effect: "allow",
        action: "*",
        resourceType: "*",
        label: "allow any action on any resource",
      },
    ],
  },
  {
    id: "bot-tools",
    source: "authored",
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
];

function loaderData(overrides: Record<string, unknown> = {}) {
  return {
    users: [
      {
        id: PRIYA_ID,
        email: "priya@cafe.test",
        name: "Priya Sharma",
        role: "member",
        status: "active",
      },
      { id: RAHUL_ID, email: "rahul@cafe.test", name: null, role: "admin", status: "active" },
    ],
    roles: ROLES,
    assignments: [
      { roleId: "admin", assignees: [{ principalId: RAHUL_ID, expiresAt: null }] },
      { roleId: "member", assignees: [{ principalId: PRIYA_ID, expiresAt: null }] },
      {
        roleId: "support-operators",
        assignees: [{ principalId: "service:billing-api", expiresAt: null }],
      },
    ],
    teams: [
      {
        id: "front-of-house",
        expiresAt: null,
        members: [{ principalId: PRIYA_ID, expiresAt: null }],
        roles: [{ roleId: "support-operators", expiresAt: null }],
      },
    ],
    selectedId: "",
    selectedAccess: null,
    ...overrides,
  };
}

function renderPage(data: Record<string, unknown> = loaderData()) {
  vi.mocked(remix.useLoaderData).mockReturnValue(data);
  const Stub = createRemixStub([{ path: "/", Component: AccessPeople }]);
  render(<Stub initialEntries={["/"]} />);
}

beforeEach(() => {
  sessionUserId = "someone-else";
});

afterEach(() => {
  vi.clearAllMocks();
});

test("lists people by name and email, never by principal id", () => {
  renderPage();

  expect(screen.getByText("Priya Sharma")).toBeInTheDocument();
  expect(screen.getByText("priya@cafe.test")).toBeInTheDocument();
  expect(screen.queryByText(PRIYA_ID)).not.toBeInTheDocument();
  expect(screen.queryByText(RAHUL_ID)).not.toBeInTheDocument();
});

test("shows the email as the name when nobody has set one", () => {
  renderPage();
  expect(screen.getAllByText("rahul@cafe.test")).toHaveLength(2);
});

test("filters the list by name, email or id", async () => {
  const user = userEvent.setup();
  renderPage();

  await user.type(screen.getByLabelText("Search people"), "priya");
  expect(screen.getByText("Priya Sharma")).toBeInTheDocument();
  expect(screen.queryByText("rahul@cafe.test")).not.toBeInTheDocument();
});

/*
 * A principal holding access that is not a user account still has to appear. Silently omitting it
 * would leave authority on the books that this page does not account for.
 */
test("surfaces non-human access holders under their own heading", () => {
  renderPage();

  expect(screen.getByText("Apps and automations")).toBeInTheDocument();
  expect(screen.getByText("Billing api")).toBeInTheDocument();
  expect(screen.getByText("Service, not a person")).toBeInTheDocument();
});

test("shows what a person holds in plain words, not as grant strings", () => {
  renderPage(
    loaderData({
      selectedId: PRIYA_ID,
      selectedAccess: {
        status: "ok",
        effective: {
          principalId: PRIYA_ID,
          kind: "user",
          grants: [
            {
              effect: "allow",
              action: "record.read",
              resourceType: "record.customer",
              label: "allow record.read on record.customer",
            },
          ],
        },
      },
    })
  );

  expect(screen.getByText("View Customer records")).toBeInTheDocument();
});

test("never offers the account-derived Roles as something to give or take away", () => {
  renderPage(loaderData({ selectedId: PRIYA_ID }));

  const picker = screen.getByLabelText(/Access level/);
  const options = within(picker)
    .getAllByRole("option")
    .map((option) => option.textContent);
  expect(options).not.toContain("Full access");
  expect(options).not.toContain("Everyday access");
  expect(options).toContain("Support operators");

  expect(screen.getByText("Their account: Everyday access")).toBeInTheDocument();
  expect(screen.getByText(/not something to give or take away/)).toBeInTheDocument();
});

test("explains team access instead of offering to remove it from the person", () => {
  renderPage(loaderData({ selectedId: PRIYA_ID }));

  expect(screen.getByText(/In team: Front of house/)).toBeInTheDocument();
  expect(screen.getByText(/Remove them from it to take it away/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Take away" })).not.toBeInTheDocument();
});

test("gives access with no expiry when no date is chosen", async () => {
  const user = userEvent.setup();
  renderPage(loaderData({ selectedId: PRIYA_ID }));

  await user.selectOptions(screen.getByLabelText(/Access level/), "support-operators");
  await user.click(screen.getByRole("button", { name: "Give access" }));

  await waitFor(() =>
    expect(assignRole).toHaveBeenCalledWith("support-operators", PRIYA_ID, undefined)
  );
});

test("treats a chosen date as the end of that day", async () => {
  const user = userEvent.setup();
  renderPage(loaderData({ selectedId: PRIYA_ID }));

  await user.selectOptions(screen.getByLabelText(/Access level/), "support-operators");
  await user.type(screen.getByLabelText(/Until/), "2027-03-05");
  await user.click(screen.getByRole("button", { name: "Give access" }));

  await waitFor(() => expect(assignRole).toHaveBeenCalled());
  const expiry = vi.mocked(assignRole).mock.calls[0]?.[2];
  expect(new Date(String(expiry)).toISOString()).toBe(
    new Date("2027-03-05T23:59:59").toISOString()
  );
});

test("labels direct person exceptions and shows whether they expire", () => {
  renderPage(
    loaderData({
      selectedId: PRIYA_ID,
      assignments: [
        { roleId: "member", assignees: [{ principalId: PRIYA_ID, expiresAt: null }] },
        {
          roleId: "support-operators",
          assignees: [{ principalId: PRIYA_ID, expiresAt: "2027-03-05T23:59:59.000Z" }],
        },
      ],
    })
  );

  expect(screen.getByText("Direct exception")).toBeInTheDocument();
  expect(screen.getAllByText(/^Until /).some((element) => element.tagName === "SPAN")).toBe(true);
});

test("takes access away only after a confirmation step", async () => {
  const user = userEvent.setup();
  renderPage(
    loaderData({
      selectedId: PRIYA_ID,
      assignments: [
        { roleId: "member", assignees: [{ principalId: PRIYA_ID, expiresAt: null }] },
        { roleId: "support-operators", assignees: [{ principalId: PRIYA_ID, expiresAt: null }] },
      ],
    })
  );

  await user.click(screen.getByRole("button", { name: "Take away" }));
  expect(revokeRole).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Yes, take it away" }));
  await waitFor(() => expect(revokeRole).toHaveBeenCalledWith("support-operators", PRIYA_ID));
});

test("does not warn about a Role that is not what gives someone their access", () => {
  sessionUserId = PRIYA_ID;
  renderPage(
    loaderData({
      selectedId: PRIYA_ID,
      assignments: [
        { roleId: "admin", assignees: [{ principalId: RAHUL_ID, expiresAt: null }] },
        { roleId: "support-operators", assignees: [{ principalId: PRIYA_ID, expiresAt: null }] },
      ],
    })
  );

  expect(screen.getByRole("button", { name: "Take away" })).toBeInTheDocument();
  expect(screen.queryByText(/This is you/)).not.toBeInTheDocument();
});

test("warns when the Role really is the only thing holding someone up", () => {
  sessionUserId = PRIYA_ID;
  renderPage(
    loaderData({
      selectedId: PRIYA_ID,
      assignments: [
        { roleId: "admin", assignees: [{ principalId: RAHUL_ID, expiresAt: null }] },
        { roleId: "owner", assignees: [{ principalId: PRIYA_ID, expiresAt: null }] },
      ],
    })
  );

  expect(screen.getByText(/This is you/)).toBeInTheDocument();
});

/*
 * Stripping the last one is not undoable by anything in the product — not this page, not the
 * API — so the button is absent rather than merely warned about.
 */
test("will not take away the last unrestricted access in the business", () => {
  renderPage(
    loaderData({
      users: [
        {
          id: PRIYA_ID,
          email: "priya@cafe.test",
          name: "Priya Sharma",
          role: "member",
          status: "active",
        },
      ],
      selectedId: PRIYA_ID,
      teams: [],
      assignments: [{ roleId: "owner", assignees: [{ principalId: PRIYA_ID, expiresAt: null }] }],
    })
  );

  expect(screen.queryByRole("button", { name: "Take away" })).not.toBeInTheDocument();
  expect(screen.getByText(/last full access in the business/)).toBeInTheDocument();
});

test("allows it once somebody else holds unrestricted access too", () => {
  renderPage(
    loaderData({
      selectedId: PRIYA_ID,
      assignments: [
        { roleId: "admin", assignees: [{ principalId: RAHUL_ID, expiresAt: null }] },
        { roleId: "owner", assignees: [{ principalId: PRIYA_ID, expiresAt: null }] },
      ],
    })
  );

  expect(screen.getByRole("button", { name: "Take away" })).toBeInTheDocument();
});

/*
 * When no unrestricted access exists anywhere, no take-away can be the last one — an empty list
 * must not read as "every keeper is this person", which is what a bare `every()` would say.
 */
test("takes away an ordinary Role when nobody holds full access at all", () => {
  renderPage(
    loaderData({
      users: [
        {
          id: PRIYA_ID,
          email: "priya@cafe.test",
          name: "Priya Sharma",
          role: "member",
          status: "active",
        },
      ],
      selectedId: PRIYA_ID,
      teams: [],
      assignments: [
        { roleId: "support-operators", assignees: [{ principalId: PRIYA_ID, expiresAt: null }] },
      ],
    })
  );

  expect(screen.getByRole("button", { name: "Take away" })).toBeInTheDocument();
});

/*
 * The sole admin holding Owner on top of their own account: the Role is takeable, because the
 * account still carries full access and this button cannot touch it.
 */
test("takes away a Role when the same person still has full access from their account", () => {
  sessionUserId = RAHUL_ID;
  renderPage(
    loaderData({
      users: [
        { id: RAHUL_ID, email: "rahul@cafe.test", name: null, role: "admin", status: "active" },
      ],
      selectedId: RAHUL_ID,
      teams: [],
      assignments: [
        { roleId: "admin", assignees: [{ principalId: RAHUL_ID, expiresAt: null }] },
        { roleId: "owner", assignees: [{ principalId: RAHUL_ID, expiresAt: null }] },
      ],
    })
  );

  expect(screen.getByRole("button", { name: "Take away" })).toBeInTheDocument();
  expect(screen.queryByText(/last full access in the business/)).not.toBeInTheDocument();
  expect(screen.queryByText(/This is you/)).not.toBeInTheDocument();
});

/*
 * An account that cannot sign in cannot rescue anybody, so it must not be counted as the somebody
 * else who could give access back.
 */
test("does not count a turned-off account as somebody who could give it back", () => {
  renderPage(
    loaderData({
      users: [
        {
          id: PRIYA_ID,
          email: "priya@cafe.test",
          name: "Priya Sharma",
          role: "member",
          status: "active",
        },
        { id: RAHUL_ID, email: "rahul@cafe.test", name: null, role: "admin", status: "disabled" },
      ],
      selectedId: PRIYA_ID,
      teams: [],
      assignments: [
        { roleId: "admin", assignees: [{ principalId: RAHUL_ID, expiresAt: null }] },
        { roleId: "owner", assignees: [{ principalId: PRIYA_ID, expiresAt: null }] },
      ],
    })
  );

  expect(screen.queryByRole("button", { name: "Take away" })).not.toBeInTheDocument();
});

test("says so plainly when nobody has an account yet", () => {
  renderPage(loaderData({ users: [], assignments: [], teams: [] }));
  expect(screen.getByText(/Nobody yet/)).toBeInTheDocument();
});

test("invites someone and shows the link exactly once, with the token in the fragment", async () => {
  const user = userEvent.setup();
  vi.mocked(createUser).mockResolvedValue({
    user: { id: "new-1", email: "new@cafe.test", name: null, role: "member", status: "invited" },
    invite: { token: "tok-123", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  });
  renderPage();

  await user.click(screen.getByRole("button", { name: /Invite someone/ }));
  await user.type(screen.getByLabelText(/Email/), "new@cafe.test");
  await user.click(screen.getByRole("button", { name: "Create the invite link" }));

  await waitFor(() => expect(createUser).toHaveBeenCalledWith("new@cafe.test"));
  const link = await screen.findByText(/\/accept-invite#token=tok-123$/);
  expect(link.textContent).not.toContain("?token=");
});

test("an unaccepted invite is visible on the row, not only inside the person", () => {
  renderPage(
    loaderData({
      users: [
        {
          id: PRIYA_ID,
          email: "priya@cafe.test",
          name: "Priya Sharma",
          role: "member",
          status: "invited",
        },
      ],
    })
  );
  expect(screen.getByText("Invite not accepted")).toBeInTheDocument();
});

test("offers a reset link for an active account and a new invite for a pending one", async () => {
  renderPage(loaderData({ selectedId: PRIYA_ID }));
  expect(screen.getByRole("button", { name: "Send a password reset link" })).toBeInTheDocument();

  renderPage(
    loaderData({
      selectedId: PRIYA_ID,
      users: [
        {
          id: PRIYA_ID,
          email: "priya@cafe.test",
          name: "Priya Sharma",
          role: "member",
          status: "invited",
        },
      ],
    })
  );
  expect(screen.getAllByRole("button", { name: "Send a new invite link" }).length).toBeGreaterThan(
    0
  );
});

/*
 * A turned-off account must offer no way back in. Issuing a link for one would hand back an
 * identity an owner deliberately switched off — the single combination that must be unreachable.
 */
test("offers no sign-in link for an account that is turned off", () => {
  renderPage(
    loaderData({
      selectedId: PRIYA_ID,
      users: [
        {
          id: PRIYA_ID,
          email: "priya@cafe.test",
          name: "Priya Sharma",
          role: "member",
          status: "disabled",
        },
      ],
    })
  );

  expect(screen.getAllByText("Cannot sign in")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /link/i })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Let them sign in again" })).toBeInTheDocument();
});

test("turning an account off asks first; turning it back on does not", async () => {
  const user = userEvent.setup();
  renderPage(loaderData({ selectedId: PRIYA_ID }));

  await user.click(screen.getByRole("button", { name: "Turn off this account" }));
  expect(setUserStatus).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Yes, turn it off" }));
  await waitFor(() => expect(setUserStatus).toHaveBeenCalledWith(PRIYA_ID, "disabled"));
});

test("turns a disabled account back on in one click", async () => {
  const user = userEvent.setup();
  renderPage(
    loaderData({
      selectedId: PRIYA_ID,
      users: [
        {
          id: PRIYA_ID,
          email: "priya@cafe.test",
          name: "Priya Sharma",
          role: "member",
          status: "disabled",
        },
      ],
    })
  );

  await user.click(screen.getByRole("button", { name: "Let them sign in again" }));
  await waitFor(() => expect(setUserStatus).toHaveBeenCalledWith(PRIYA_ID, "active"));
});

test("offers no account controls for another admin", () => {
  renderPage(loaderData({ selectedId: RAHUL_ID }));

  expect(screen.queryByRole("button", { name: /link/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Turn off/ })).not.toBeInTheDocument();
  expect(screen.getByText(/cannot be changed from here/)).toBeInTheDocument();
});

test("issues a fresh sign-in link and surfaces it for sharing", async () => {
  const user = userEvent.setup();
  vi.mocked(reissueInvite).mockResolvedValue({
    token: "tok-fresh",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  renderPage(loaderData({ selectedId: PRIYA_ID }));

  await user.click(screen.getByRole("button", { name: "Send a password reset link" }));

  await waitFor(() => expect(reissueInvite).toHaveBeenCalledWith(PRIYA_ID));
  expect(await screen.findByText(/#token=tok-fresh$/)).toBeInTheDocument();
});

test("explains each access level in the same words as the rest of the page", () => {
  renderPage();

  expect(screen.getByText("What each level of access means")).toBeInTheDocument();
  expect(
    screen.getByText("Day-to-day work. Cannot manage people or settings.")
  ).toBeInTheDocument();
  expect(screen.getByText("Covers records.")).toBeInTheDocument();
});

/* A brand-new invite is `not-authenticatable`, which the layer model classes as a fault. */
test("does not raise a fault for an invite nobody has opened yet", () => {
  renderPage(
    loaderData({
      selectedId: PRIYA_ID,
      users: [
        {
          id: PRIYA_ID,
          email: "priya@cafe.test",
          name: "Priya Sharma",
          role: "member",
          status: "invited",
        },
      ],
      selectedAccess: {
        status: "ok",
        effective: {
          principalId: PRIYA_ID,
          kind: "user",
          grants: [],
          emptyReason: "not-authenticatable",
        },
      },
    })
  );

  expect(screen.getByText(/have not opened their invite yet/)).toBeInTheDocument();
  expect(screen.queryByText(/suspended or expired/)).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("says plainly that a turned-off account holds nothing", () => {
  renderPage(
    loaderData({
      selectedId: PRIYA_ID,
      users: [
        {
          id: PRIYA_ID,
          email: "priya@cafe.test",
          name: "Priya Sharma",
          role: "member",
          status: "disabled",
        },
      ],
      selectedAccess: {
        status: "ok",
        effective: {
          principalId: PRIYA_ID,
          kind: "user",
          grants: [],
          emptyReason: "not-authenticatable",
        },
      },
    })
  );

  expect(screen.getByText(/turned off, so nothing applies/)).toBeInTheDocument();
});

/*
 * The suppression is narrow on purpose. An account that can sign in perfectly well and still comes
 * back `not-authenticatable` is a genuine fault, and must stay loud.
 */
test("still raises the fault when the account status does not explain it", () => {
  renderPage(
    loaderData({
      selectedId: PRIYA_ID,
      selectedAccess: {
        status: "ok",
        effective: {
          principalId: PRIYA_ID,
          kind: "user",
          grants: [],
          emptyReason: "not-authenticatable",
        },
      },
    })
  );

  expect(screen.getByRole("alert")).toHaveTextContent(/suspended or expired/);
});

/* The status explains *one* emptiness — the account cannot authenticate yet. */
test("an unopened invite does not silence an unrelated fault", () => {
  renderPage(
    loaderData({
      selectedId: PRIYA_ID,
      users: [
        {
          id: PRIYA_ID,
          email: "priya@cafe.test",
          name: "Priya Sharma",
          role: "member",
          status: "invited",
        },
      ],
      selectedAccess: {
        status: "ok",
        effective: {
          principalId: PRIYA_ID,
          kind: "user",
          grants: [],
          emptyReason: "unknown-role",
        },
      },
    })
  );

  expect(screen.getByRole("alert")).toBeInTheDocument();
});

test("does not offer a person a Role only an assistant may hold", () => {
  renderPage(loaderData({ selectedId: PRIYA_ID }));

  const options = within(screen.getByLabelText(/Access level/))
    .getAllByRole("option")
    .map((option) => option.textContent);
  expect(options).not.toContain("Bot tools");
  expect(options).toContain("Support operators");
});
