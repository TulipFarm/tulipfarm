import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentSummary } from "~/lib/agents";
import { type AuthzRole, assignRole, registerPrincipal, revokeRole } from "~/lib/authz";
import AccessAgents from "./_app.business.access.agents";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useRevalidator: vi.fn(() => ({ revalidate: vi.fn(), state: "idle" })),
  };
});

vi.mock("~/lib/authz", async () => ({
  ...(await vi.importActual<typeof import("~/lib/authz")>("~/lib/authz")),
  assignRole: vi.fn().mockResolvedValue({ status: "ok" }),
  listRoleAssignees: vi.fn(),
  listRoles: vi.fn(),
  registerPrincipal: vi.fn().mockResolvedValue({ status: "ok" }),
  revokeRole: vi.fn().mockResolvedValue(undefined),
}));

const role = (id: string, assignableTo: string[]): AuthzRole => ({
  id,
  source: "authored",
  displayName: null,
  slug: null,
  assignableTo,
  parentRoleIds: [],
  expiresAt: null,
  grants: [],
});

const AGENTS: AgentSummary[] = [{ name: "hr-agent" }, { name: "finance-agent" }];
const ROLES: AuthzRole[] = [role("hr-team", ["user", "agent"]), role("people-only", ["user"])];

function load(data: {
  agents?: AgentSummary[];
  roles?: AuthzRole[];
  held?: { roleId: string; assignees: string[] }[];
}) {
  vi.mocked(remix.useLoaderData).mockReturnValue({
    agents: data.agents ?? AGENTS,
    roles: data.roles ?? ROLES,
    held: data.held ?? [
      { roleId: "hr-team", assignees: [] },
      { roleId: "people-only", assignees: [] },
    ],
  });
  const Stub = createRemixStub([{ path: "/", Component: AccessAgents }]);
  render(<Stub initialEntries={["/"]} />);
}

afterEach(() => vi.clearAllMocks());

test("gives an agent a team, registering its principal first", async () => {
  // The Soul never writes a Principal row for an Agent, so a grant that skipped registration
  // would fail with `principal_not_found` and the team would silently never apply.
  load({});

  await userEvent.selectOptions(screen.getByLabelText("Team for hr-agent"), "hr-team");
  await userEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);

  await waitFor(() => expect(assignRole).toHaveBeenCalledWith("hr-team", "hr-agent"));
  expect(registerPrincipal).toHaveBeenCalledWith("hr-agent", "agent");
  expect(vi.mocked(registerPrincipal).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(assignRole).mock.invocationCallOrder[0]
  );
});

test("never offers a team that was authored for people only", async () => {
  load({});

  const picker = screen.getByLabelText("Team for hr-agent");
  expect(within(picker).queryByRole("option", { name: /People only/i })).toBeNull();
  expect(within(picker).getByRole("option", { name: /Hr team/i })).toBeTruthy();
});

test("says which team an agent writes for, and takes it away again", async () => {
  load({ held: [{ roleId: "hr-team", assignees: ["hr-agent"] }] });

  expect(screen.getByText(/Writes for Hr team/i)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /Remove Hr team/i }));
  await waitFor(() => expect(revokeRole).toHaveBeenCalledWith("hr-team", "hr-agent"));
});

test("says plainly when an agent has no team, because that is the default", async () => {
  load({});
  expect(screen.getAllByText(/only the person who asks can open what it writes/i)).toHaveLength(2);
});

test("explains the empty state rather than showing a picker with nothing in it", async () => {
  load({
    roles: [role("people-only", ["user"])],
    held: [{ roleId: "people-only", assignees: [] }],
  });
  expect(screen.getByText(/No team accepts agents yet/i)).toBeTruthy();
});
