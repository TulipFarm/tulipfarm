import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "~/lib/api";
import * as teamsApi from "~/lib/teams";
import * as session from "~/lib/use-session-user";
import TeamDetailRoute from "./_app.business.access.teams.$slug";

const revalidate = vi.fn();

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
    useRevalidator: () => ({ revalidate, state: "idle" }),
    useRouteError: vi.fn(),
  };
});

vi.mock("~/lib/use-session-user", () => ({
  useIsAdmin: vi.fn(),
  useSessionUser: vi.fn(),
}));

vi.mock("~/lib/teams", async () => {
  const actual = await vi.importActual<typeof import("~/lib/teams")>("~/lib/teams");
  return {
    ...actual,
    updateTeam: vi.fn(),
    previewTeamMove: vi.fn(),
    confirmTeamMove: vi.fn(),
    archiveTeam: vi.fn(),
    deleteTeam: vi.fn(),
    recoverTeamAdmin: vi.fn(),
    assignTeamRole: vi.fn(),
    revokeTeamRole: vi.fn(),
    addTeamGrant: vi.fn(),
    deleteTeamGrant: vi.fn(),
    updateTeamDelegationPolicy: vi.fn(),
    explainTeamAccess: vi.fn(),
    addTeamMembers: vi.fn(),
    updateTeamMember: vi.fn(),
    removeTeamMember: vi.fn(),
    removeTeamMembers: vi.fn(),
    requestTeamLeave: vi.fn(),
    decideTeamLeave: vi.fn(),
    decideOwnershipApproval: vi.fn(),
    completeOwnershipOperation: vi.fn(),
    emergencyOverrideOwnershipOperation: vi.fn(),
    listOwnershipApprovals: vi.fn(),
    listTeamAssets: vi.fn(),
    updateTeamAssetShares: vi.fn(),
    proposeTeamAssetOperation: vi.fn(),
  };
});

const EVERYONE: teamsApi.TeamDirectoryEntry = {
  id: "10000000-0000-4000-8000-000000000001",
  businessId: "business",
  slug: "everyone",
  displayName: "Everyone",
  description: "Company root",
  status: "active" as const,
  parentTeamId: null,
  revision: 1,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  archivedAt: null,
  members: [],
};

const PRODUCT: teamsApi.TeamDirectoryEntry = {
  ...EVERYONE,
  id: "10000000-0000-4000-8000-000000000002",
  slug: "product",
  displayName: "Product",
  description: "Builds the product.",
  parentTeamId: EVERYONE.id,
  revision: 3,
  members: [
    { principalId: "team-admin", name: "Muskan Vijayvargiya", level: "admin" as const },
    { principalId: "member", name: "Aarav Shah", level: "member" as const },
  ],
};

const CHILD: teamsApi.TeamDirectoryEntry = {
  ...EVERYONE,
  id: "10000000-0000-4000-8000-000000000003",
  slug: "design",
  displayName: "Design",
  parentTeamId: PRODUCT.id,
};

const ASSET_FIXTURES: teamsApi.TeamAssetCatalogItem[] = [
  teamAsset("agent", "support-agent", "Support Agent", "owned", PRODUCT.id, "edit"),
  teamAsset("skill", "triage", "Triage", "shared", PRODUCT.id, "use"),
  teamAsset("routine", "routine-1", "Morning routine", "inherited", EVERYONE.id, "use"),
  teamAsset("file", "file-1", "Launch plan.pdf", "shared", PRODUCT.id, "view"),
  teamAsset("knowledge", "page-1", "Launch notes", "owned", PRODUCT.id, "edit"),
];

function data(options?: { partial?: boolean }) {
  return {
    team: PRODUCT,
    directoryTeam: PRODUCT,
    teams: [EVERYONE, PRODUCT, CHILD],
    hierarchy: [
      { teamId: EVERYONE.id, parentTeamId: null, ancestorTeamIds: [], depth: 1 },
      {
        teamId: PRODUCT.id,
        parentTeamId: EVERYONE.id,
        ancestorTeamIds: [EVERYONE.id],
        depth: 2,
      },
      {
        teamId: CHILD.id,
        parentTeamId: PRODUCT.id,
        ancestorTeamIds: [PRODUCT.id, EVERYONE.id],
        depth: 3,
      },
    ],
    members: options?.partial
      ? { ok: false as const, message: "forbidden" }
      : {
          ok: true as const,
          value: {
            direct: [
              {
                membership: "direct" as const,
                sourceTeamId: PRODUCT.id,
                pathTeamIds: [PRODUCT.id],
                principalId: "team-admin",
                principalKind: "user" as const,
                level: "admin" as const,
                expiresAt: null,
                removable: true,
                revision: 1,
              },
              {
                membership: "direct" as const,
                sourceTeamId: PRODUCT.id,
                pathTeamIds: [PRODUCT.id],
                principalId: "member",
                principalKind: "user" as const,
                level: "member" as const,
                expiresAt: "2026-10-01T00:00:00.000Z",
                removable: true,
                revision: 2,
              },
              {
                membership: "direct" as const,
                sourceTeamId: PRODUCT.id,
                pathTeamIds: [PRODUCT.id],
                principalId: "agent-one",
                principalKind: "agent" as const,
                level: "member" as const,
                expiresAt: null,
                removable: true,
                revision: 1,
              },
            ],
            inherited: [
              {
                membership: "inherited" as const,
                sourceTeamId: CHILD.id,
                pathTeamIds: [CHILD.id, PRODUCT.id],
                principalId: "service-one",
                principalKind: "service" as const,
                level: "member" as const,
                expiresAt: null,
                removable: false,
                revision: 1,
              },
            ],
          },
        },
    authority: options?.partial
      ? { ok: false as const, message: "forbidden" }
      : {
          ok: true as const,
          value: {
            directRoles: [
              {
                source: "direct" as const,
                sourceTeamId: PRODUCT.id,
                pathTeamIds: [PRODUCT.id],
                roleId: "product-editor",
                expiresAt: null,
                assignedAt: "2026-09-05T00:00:00.000Z",
              },
            ],
            inheritedRoles: [] as teamsApi.TeamRole[],
            directGrants: [] as teamsApi.TeamGrant[],
            inheritedGrants: [] as teamsApi.TeamGrant[],
          },
        },
    activity: options?.partial
      ? { ok: false as const, message: "forbidden" }
      : {
          ok: true as const,
          value: {
            items: [
              {
                id: "event-1",
                action: "team.updated",
                actorId: "team-admin",
                targetId: PRODUCT.id,
                summary: "Team details changed",
                target: `team:${PRODUCT.id}`,
                reason: null as string | null,
                outcome: "succeeded" as const,
                emergency: false as boolean,
                metadata: {},
                createdAt: "2026-09-05T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          },
        },
    approvals: options?.partial
      ? { ok: false as const, message: "forbidden" }
      : {
          ok: true as const,
          value: {
            items: [] as teamsApi.OwnershipApproval[],
            nextCursor: null as string | null,
          },
        },
    assets: options?.partial
      ? { ok: false as const, message: "forbidden" }
      : {
          ok: true as const,
          value: {
            items: ASSET_FIXTURES,
            nextCursor: null as string | null,
            blockers: [] as string[],
          },
        },
    roles: {
      ok: true as const,
      value: {
        roles: [
          {
            id: "product-editor",
            source: "authored" as const,
            displayName: "Product editor",
            slug: "product-editor",
            assignableTo: ["user", "team"],
            parentRoleIds: [],
            grants: [],
            expiresAt: null,
          },
          {
            id: "people-only",
            source: "authored" as const,
            displayName: "People only",
            slug: "people-only",
            assignableTo: ["user"],
            parentRoleIds: [],
            grants: [],
            expiresAt: null,
          },
          {
            id: "team-reader",
            source: "authored" as const,
            displayName: "Team reader",
            slug: "team-reader",
            assignableTo: ["team"],
            parentRoleIds: [],
            grants: [],
            expiresAt: null,
          },
        ],
      },
    },
    policy: {
      ok: true as const,
      value: {
        teamId: PRODUCT.id,
        allowedRoleIds: ["team-reader"],
        allowedGrantScopes: [{ actions: ["record.read"], resourceTypes: ["ticket"] }],
        revision: 2,
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
    },
    users: {
      ok: true as const,
      value: [
        {
          id: "team-admin",
          email: "admin@example.com",
          name: "Muskan Vijayvargiya",
          role: "member" as const,
          status: "active" as const,
        },
        {
          id: "member",
          email: "aarav@example.com",
          name: "Aarav Shah",
          role: "member" as const,
          status: "active" as const,
        },
      ],
    },
    agents: {
      ok: true as const,
      value: [{ name: "agent-one", label: "Support Agent" }],
    },
    services: {
      ok: true as const,
      value: [
        { id: "service-one", clientId: "svc_1", name: "Deploy bot", status: "active" as const },
      ],
    },
    leaveRequests: {
      ok: true as const,
      value: {
        requests: [
          {
            id: "30000000-0000-4000-8000-000000000001",
            teamId: PRODUCT.id,
            principalId: "member",
            status: "pending" as const,
            revision: 1,
            requestedAt: "2026-09-05T00:00:00.000Z",
            decidedAt: null,
            decidedByPrincipalId: null,
          },
        ],
      },
    },
  };
}

function renderPage(path = "/business/access/teams/product", loaderData = data()) {
  vi.mocked(remix.useLoaderData).mockReturnValue(loaderData);
  const Stub = createRemixStub([
    { path: "/business/access/teams/:slug", Component: TeamDetailRoute },
    { path: "/business/access/teams", Component: () => <p>Team directory</p> },
    { path: "/teams/:slug", Component: TeamDetailRoute },
    { path: "/teams", Component: () => <p>Team directory</p> },
  ]);
  return render(<Stub initialEntries={[path]} />);
}

function teamAsset(
  assetType: teamsApi.TeamAssetCatalogItem["assetType"],
  id: string,
  label: string,
  source: teamsApi.TeamAssetCatalogItem["source"],
  sourceTeamId: string,
  accessLevel: "view" | "use" | "edit"
): teamsApi.TeamAssetCatalogItem {
  return {
    assetType,
    id,
    label,
    description: null,
    href: `/${assetType}s/${id}`,
    lifecycleStatus: "active",
    source,
    sourceTeamIds: [sourceTeamId],
    effectiveLevels:
      accessLevel === "edit"
        ? ["view", "use", "edit"]
        : accessLevel === "use"
          ? ["view", "use"]
          : ["view"],
    canManageOwnership: accessLevel === "edit",
    ownership: {
      owners:
        source === "shared"
          ? [{ kind: "team" as const, teamId: EVERYONE.id }]
          : [{ kind: "team" as const, teamId: sourceTeamId }],
      shares: source === "shared" ? [{ teamId: sourceTeamId, access: accessLevel }] : [],
      revision: 1,
    },
    approvals: [],
  };
}

function assetOwnership(item: teamsApi.TeamAssetCatalogItem): teamsApi.TeamAssetOwnership {
  if (!item.ownership) throw new Error(`Expected ownership for ${item.id}`);
  return item.ownership;
}

beforeEach(() => {
  vi.mocked(teamsApi.listTeamAssets).mockImplementation(async (input) => ({
    items: ASSET_FIXTURES.filter(
      (item) =>
        (!input.type || item.assetType === input.type) &&
        (!input.source || item.source === input.source) &&
        (!input.access || item.effectiveLevels.includes(input.access)) &&
        (!input.ownerTeamId ||
          item.ownership?.owners.some(
            (owner) => owner.kind === "team" && owner.teamId === input.ownerTeamId
          )) &&
        (!input.lifecycleStatus || item.lifecycleStatus === input.lifecycleStatus)
    ),
    nextCursor: null,
    blockers: [],
  }));
  vi.mocked(session.useSessionUser).mockReturnValue({
    id: "team-admin",
    email: "admin@example.com",
    name: "Muskan Vijayvargiya",
    role: "member",
    status: "active",
    navigation: { visiblePaths: [] },
  });
  vi.mocked(session.useIsAdmin).mockReturnValue(false);
});
afterEach(() => vi.clearAllMocks());

test("shows the accessible Team sub-navigation and operational Overview", () => {
  renderPage();

  const nav = screen.getByRole("navigation", { name: "Team sections" });
  expect(nav).toBeInTheDocument();
  for (const label of [
    "Overview",
    "Members",
    "Agents",
    "Skills",
    "Routines",
    "Files",
    "Knowledge",
    "Roles & access",
    "Activity",
    "Settings",
  ]) {
    expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  }
  expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByText("Muskan Vijayvargiya")).toBeInTheDocument();
  expect(screen.getByText("product-editor")).toBeInTheDocument();
  expect(screen.getByText("Team details changed")).toBeInTheDocument();
  expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(5);
});

test("covers the focused Team web acceptance journey", () => {
  const loaderData = data();
  if (!loaderData.approvals.ok) throw new Error("expected Approval fixture");
  loaderData.approvals.value.items = [
    {
      approvalId: "approval-1",
      operationId: "approval-1",
      assetType: "agent",
      assetId: "support",
      action: "delete",
      risk: "high",
      preview: "delete agent support",
      riskSummary: "Changes shared asset ownership or lifecycle",
      status: "pending",
      requiredTeamIds: [PRODUCT.id],
      decisions: 0,
      requiredDecisions: 1,
      readyToComplete: false,
      representedTeamId: PRODUCT.id,
      canDecide: true,
      expiresAt: "2026-09-06T00:00:00.000Z",
      createdAt: "2026-09-05T00:00:00.000Z",
    },
  ];

  const overview = renderPage("/business/access/teams/product", loaderData);
  expect(screen.getByText("Builds the product.")).toBeInTheDocument();
  expect(screen.getByText("delete agent support")).toBeInTheDocument();
  expect(screen.getByText("Team details changed")).toBeInTheDocument();
  overview.unmount();

  const members = renderPage("/business/access/teams/product?section=members", loaderData);
  expect(screen.getAllByText("Aarav Shah").length).toBeGreaterThan(0);
  expect(screen.getByText("Support Agent")).toBeInTheDocument();
  expect(screen.getByText("Deploy bot")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "from Design" })).toBeInTheDocument();
  members.unmount();
});

test("keeps Overview useful when protected summaries fail independently", () => {
  renderPage("/business/access/teams/product", data({ partial: true }));

  expect(screen.getByText("Builds the product.")).toBeInTheDocument();
  expect(screen.getByText("Member counts are unavailable or restricted.")).toBeInTheDocument();
  expect(screen.getByText("Role details are unavailable or restricted.")).toBeInTheDocument();
  expect(screen.getByText("Recent Activity is unavailable or restricted.")).toBeInTheDocument();
  expect(screen.getByText(/Ownership Approvals are unavailable/)).toBeInTheDocument();
});

test.each([
  ["/business/access/teams/product?section=agents", "Support Agent"],
  ["/business/access/teams/product?section=skills", "Triage"],
  ["/business/access/teams/product?section=routines", "Morning routine"],
  ["/business/access/teams/product?section=files", "Launch plan.pdf"],
  ["/business/access/teams/product?section=knowledge", "Launch notes"],
])("shows Team assets in %s", (path, asset) => {
  renderPage(path);

  expect(screen.getByText(asset)).toBeInTheDocument();
  expect(screen.getByLabelText("Source")).toBeInTheDocument();
  expect(screen.getByLabelText("Access level")).toBeInTheDocument();
  expect(screen.getByLabelText("Owner Team")).toBeInTheDocument();
  expect(screen.getByLabelText("Lifecycle status")).toBeInTheDocument();
});

test("filters Team assets by source, access, owner Team, and lifecycle status", async () => {
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=skills");

  expect(screen.getByText("Triage")).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Source"), "owned");
  expect(screen.queryByText("Triage")).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Source"), "shared");
  await user.selectOptions(screen.getByLabelText("Access level"), "use");
  await user.selectOptions(screen.getByLabelText("Owner Team"), EVERYONE.id);
  await user.selectOptions(screen.getByLabelText("Lifecycle status"), "active");
  expect(screen.getByText("Triage")).toBeInTheDocument();
  expect(teamsApi.listTeamAssets).toHaveBeenLastCalledWith({
    teamId: PRODUCT.id,
    type: "skill",
    source: "shared",
    access: "use",
    ownerTeamId: EVERYONE.id,
    lifecycleStatus: "active",
    limit: 25,
  });
});

test("loads the next server asset page with its cursor", async () => {
  vi.mocked(teamsApi.listTeamAssets).mockResolvedValueOnce({
    items: [teamAsset("agent", "sales-agent", "Sales Agent", "shared", CHILD.id, "view")],
    nextCursor: null,
    blockers: [],
  });
  const loaderData = data();
  if (!loaderData.assets.ok) throw new Error("expected asset fixture");
  loaderData.assets.value.nextCursor = "cursor-2";
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=agents", loaderData);

  await user.click(await screen.findByRole("button", { name: "Load more" }));

  expect(await screen.findByText("Sales Agent")).toBeInTheDocument();
  expect(teamsApi.listTeamAssets).toHaveBeenLastCalledWith({
    teamId: PRODUCT.id,
    type: "agent",
    cursor: "cursor-2",
    limit: 25,
  });
});

test("uses authoritative effective access instead of inferring Edit from ownership", async () => {
  const loaderData = data();
  if (!loaderData.assets.ok) throw new Error("expected asset fixture");
  loaderData.assets.value.items = [
    {
      ...ASSET_FIXTURES[0],
      effectiveLevels: ["view"],
      canManageOwnership: false,
    },
  ];
  renderPage("/business/access/teams/product?section=agents", loaderData);

  expect(await screen.findByText("Ownership management is not granted.")).toBeInTheDocument();
  expect(screen.queryByText("The server grants ownership management.")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Share Support Agent" })).not.toBeInTheDocument();
});

test("does not claim owner or Approval details for redacted asset rows", () => {
  const loaderData = data();
  if (!loaderData.assets.ok) throw new Error("expected asset fixture");
  loaderData.assets.value.items = [
    {
      ...ASSET_FIXTURES[0],
      ownership: null,
      approvals: [],
      sourceTeamIds: [],
      canManageOwnership: false,
    },
  ];

  renderPage("/business/access/teams/product?section=agents", loaderData);

  expect(screen.getByText("Ownership details restricted")).toBeInTheDocument();
  expect(screen.getByText("Approval details restricted")).toBeInTheDocument();
  expect(screen.getByLabelText("Select Support Agent")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Share Support Agent" })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Propose delete for Support Agent" })
  ).not.toBeInTheDocument();
});

test("offers create and edit only when asset authority permits it", () => {
  const first = renderPage("/business/access/teams/product?section=agents");

  expect(screen.getByRole("link", { name: "Create Agent" })).toHaveAttribute(
    "href",
    expect.stringContaining("Preselect%20Product%20as%20owner")
  );
  expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
    "href",
    "/agents/support-agent"
  );

  first.unmount();
  renderPage("/business/access/teams/product?section=skills");
  expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
});

test("bulk shares selected assets without changing ownership", async () => {
  vi.mocked(teamsApi.updateTeamAssetShares).mockResolvedValue(assetOwnership(ASSET_FIXTURES[0]));
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=agents");

  await user.click(screen.getByLabelText("Select Support Agent"));
  await user.selectOptions(screen.getByLabelText("Share selected with"), CHILD.id);
  await user.selectOptions(screen.getByLabelText("Share access level"), "use");
  await user.click(screen.getByRole("button", { name: "Share selected (1)" }));

  expect(teamsApi.updateTeamAssetShares).toHaveBeenCalledWith(
    "agent",
    "support-agent",
    [{ teamId: CHILD.id, access: "use" }],
    1
  );
  expect(teamsApi.proposeTeamAssetOperation).not.toHaveBeenCalled();
});

test("single-row Share requires an explicit target Team and access level", async () => {
  vi.mocked(teamsApi.updateTeamAssetShares).mockResolvedValue(assetOwnership(ASSET_FIXTURES[0]));
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=agents");

  await user.click(screen.getByRole("button", { name: "Share Support Agent" }));
  const dialog = screen.getByRole("dialog", { name: "Share Support Agent" });
  await user.click(within(dialog).getByRole("button", { name: "Share asset" }));
  expect(within(dialog).getByRole("alert")).toHaveTextContent("Choose a target Team");
  expect(teamsApi.updateTeamAssetShares).not.toHaveBeenCalled();

  await user.selectOptions(within(dialog).getByLabelText(/Target Team/), CHILD.id);
  await user.selectOptions(within(dialog).getByLabelText(/Access level/), "edit");
  await user.click(within(dialog).getByRole("button", { name: "Share asset" }));

  expect(teamsApi.updateTeamAssetShares).toHaveBeenCalledWith(
    "agent",
    "support-agent",
    [{ teamId: CHILD.id, access: "edit" }],
    1
  );
});

test("proposes a new active owning Team explicitly", async () => {
  vi.mocked(teamsApi.proposeTeamAssetOperation).mockResolvedValue({});
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=agents");

  await user.click(screen.getByRole("button", { name: "Propose add owner for Support Agent" }));
  const dialog = screen.getByRole("dialog", { name: "Add an owner to Support Agent" });
  await user.selectOptions(within(dialog).getByLabelText(/New owning Team/), CHILD.id);
  await user.click(within(dialog).getByRole("button", { name: "Request owner Approval" }));

  expect(teamsApi.proposeTeamAssetOperation).toHaveBeenCalledWith("agent", "support-agent", {
    action: "add_owner",
    teamId: CHILD.id,
    revision: 1,
  });
});

test("routes destructive and ownership actions through ownership Approval contracts", async () => {
  vi.mocked(teamsApi.proposeTeamAssetOperation).mockResolvedValue({});
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=agents");

  await user.click(screen.getByRole("button", { name: "Propose delete for Support Agent" }));

  expect(teamsApi.proposeTeamAssetOperation).toHaveBeenCalledWith("agent", "support-agent", {
    action: "delete",
    revision: 1,
  });
});

test("offers completion fallback and a reason-gated emergency override for a pending operation", async () => {
  vi.mocked(session.useIsAdmin).mockReturnValue(true);
  const pendingApproval: teamsApi.OwnershipApproval = {
    approvalId: "30000000-0000-4000-8000-000000000001",
    operationId: "40000000-0000-4000-8000-000000000001",
    assetType: "agent",
    assetId: "support-agent",
    action: "add_owner",
    risk: "high",
    preview: "Add Design as an owner",
    riskSummary: "Ownership changes",
    status: "pending",
    requiredTeamIds: [PRODUCT.id, CHILD.id],
    decisions: 2,
    requiredDecisions: 2,
    readyToComplete: true,
    representedTeamId: null,
    canDecide: false,
    expiresAt: "2026-09-12T00:00:00.000Z",
    createdAt: "2026-09-05T00:00:00.000Z",
  };
  vi.mocked(teamsApi.listTeamAssets).mockResolvedValue({
    items: [{ ...ASSET_FIXTURES[0], lifecycleStatus: "pending", approvals: [pendingApproval] }],
    nextCursor: null,
    blockers: [],
  });
  vi.mocked(teamsApi.completeOwnershipOperation).mockResolvedValue(
    assetOwnership(ASSET_FIXTURES[0])
  );
  vi.mocked(teamsApi.emergencyOverrideOwnershipOperation).mockResolvedValue(
    assetOwnership(ASSET_FIXTURES[0])
  );
  const loaderData = data();
  if (!loaderData.assets.ok) throw new Error("expected asset fixture");
  loaderData.assets.value.items = [
    { ...ASSET_FIXTURES[0], lifecycleStatus: "pending", approvals: [pendingApproval] },
  ];
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=agents", loaderData);

  await user.click(await screen.findByRole("button", { name: "Complete" }));
  expect(teamsApi.completeOwnershipOperation).toHaveBeenCalledWith(pendingApproval);

  await user.click(await screen.findByRole("button", { name: "Emergency override" }));
  const dialog = screen.getByRole("dialog", { name: "Confirm emergency override" });
  await user.click(within(dialog).getByRole("button", { name: "Use emergency override" }));
  expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter the emergency reason");
  await user.type(within(dialog).getByLabelText(/Required reason/), "Owners are unavailable");
  await user.click(within(dialog).getByRole("button", { name: "Use emergency override" }));

  expect(teamsApi.emergencyOverrideOwnershipOperation).toHaveBeenCalledWith(
    pendingApproval,
    "Owners are unavailable"
  );
});

test("shows complete Activity facts and distinguishes emergency overrides", () => {
  const loaderData = data();
  if (!loaderData.activity.ok) throw new Error("expected Activity fixture");
  loaderData.activity.value.items = [
    {
      ...loaderData.activity.value.items[0],
      id: "override-1",
      action: "asset.ownership.emergency_override",
      target: "agent:support",
      reason: "Restore service",
      emergency: true,
    },
  ];
  renderPage("/business/access/teams/product?section=activity", loaderData);

  expect(screen.getByText("Emergency override")).toBeInTheDocument();
  expect(screen.getByText("team-admin")).toBeInTheDocument();
  expect(screen.getByText("agent:support")).toBeInTheDocument();
  expect(screen.getByText("Restore service")).toBeInTheDocument();
  expect(screen.getByText("succeeded")).toBeInTheDocument();
});

test("shows ownership Approvals on Team Overview", () => {
  const loaderData = data();
  if (!loaderData.approvals.ok) throw new Error("expected Approval fixture");
  loaderData.approvals.value.items = [
    {
      approvalId: "approval-1",
      operationId: "approval-1",
      assetType: "agent",
      assetId: "support",
      action: "delete",
      risk: "high",
      preview: "delete agent support",
      riskSummary: "Changes shared asset ownership or lifecycle",
      status: "pending",
      requiredTeamIds: [PRODUCT.id],
      decisions: 0,
      requiredDecisions: 1,
      readyToComplete: false,
      representedTeamId: PRODUCT.id,
      canDecide: true,
      expiresAt: "2026-09-06T00:00:00.000Z",
      createdAt: "2026-09-05T00:00:00.000Z",
    },
  ];
  renderPage("/business/access/teams/product", loaderData);

  expect(screen.getByText("delete agent support")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
});

test("loads more Team-scoped ownership Approvals", async () => {
  const loaderData = data();
  if (!loaderData.approvals.ok) throw new Error("expected Approval fixture");
  loaderData.approvals.value = {
    items: [
      {
        approvalId: "approval-1",
        operationId: "operation-1",
        assetType: "agent",
        assetId: "support",
        action: "delete",
        risk: "high",
        preview: "delete support agent",
        riskSummary: "Changes shared asset lifecycle",
        status: "pending",
        requiredTeamIds: [PRODUCT.id],
        decisions: 0,
        requiredDecisions: 1,
        readyToComplete: false,
        representedTeamId: PRODUCT.id,
        canDecide: true,
        expiresAt: "2026-09-12T00:00:00.000Z",
        createdAt: "2026-09-05T00:00:00.000Z",
      },
    ],
    nextCursor: "page-2",
  };
  vi.mocked(teamsApi.listOwnershipApprovals).mockResolvedValue({
    items: [
      {
        approvalId: "approval-2",
        operationId: "operation-2",
        assetType: "skill",
        assetId: "triage",
        action: "archive",
        risk: "high",
        preview: "archive triage skill",
        riskSummary: "Changes shared asset lifecycle",
        status: "pending",
        requiredTeamIds: [PRODUCT.id],
        decisions: 0,
        requiredDecisions: 1,
        readyToComplete: false,
        representedTeamId: PRODUCT.id,
        canDecide: true,
        expiresAt: "2026-09-12T00:00:00.000Z",
        createdAt: "2026-09-04T00:00:00.000Z",
      },
    ],
    nextCursor: null,
  });
  const user = userEvent.setup();
  renderPage("/business/access/teams/product", loaderData);

  await user.click(screen.getByRole("button", { name: "Load more Approvals" }));

  expect(teamsApi.listOwnershipApprovals).toHaveBeenCalledWith(PRODUCT.id, {
    cursor: "page-2",
    limit: 25,
  });
  expect(await screen.findByText("archive triage skill")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load more Approvals" })).not.toBeInTheDocument();
});

test("does not offer direct completion for lifecycle Approvals", () => {
  const loaderData = data();
  if (!loaderData.approvals.ok) throw new Error("expected Approval fixture");
  loaderData.approvals.value.items = [
    {
      approvalId: "approval-1",
      operationId: "operation-1",
      assetType: "agent",
      assetId: "support",
      action: "archive",
      risk: "high",
      preview: "archive support agent",
      riskSummary: "Changes shared asset lifecycle",
      status: "pending",
      requiredTeamIds: [PRODUCT.id],
      decisions: 1,
      requiredDecisions: 1,
      readyToComplete: true,
      representedTeamId: null,
      canDecide: false,
      expiresAt: "2026-09-12T00:00:00.000Z",
      createdAt: "2026-09-05T00:00:00.000Z",
    },
  ];
  renderPage("/business/access/teams/product", loaderData);

  expect(screen.queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();
  expect(screen.getByText("Archive the asset to complete this Approval.")).toBeInTheDocument();
});

test("revalidates after a final Approval auto-completes ownership", async () => {
  const loaderData = data();
  if (!loaderData.approvals.ok) throw new Error("expected Approval fixture");
  const approval: teamsApi.OwnershipApproval = {
    approvalId: "approval-1",
    operationId: "operation-1",
    assetType: "agent",
    assetId: "support",
    action: "add_owner",
    risk: "high",
    preview: "Add Design as an owner",
    riskSummary: "Changes shared asset ownership",
    status: "pending",
    requiredTeamIds: [PRODUCT.id],
    decisions: 0,
    requiredDecisions: 1,
    readyToComplete: false,
    representedTeamId: PRODUCT.id,
    canDecide: true,
    expiresAt: "2026-09-12T00:00:00.000Z",
    createdAt: "2026-09-05T00:00:00.000Z",
  };
  loaderData.approvals.value.items = [approval];
  vi.mocked(teamsApi.decideOwnershipApproval).mockResolvedValue({
    completion: { status: "completed", readyToComplete: false },
    ownership: ASSET_FIXTURES[0].ownership,
  });
  const user = userEvent.setup();
  renderPage("/business/access/teams/product", loaderData);

  await user.click(screen.getByRole("button", { name: "Approve" }));

  expect(teamsApi.decideOwnershipApproval).toHaveBeenCalledWith(approval, "approved");
  expect(await screen.findByText("Approval recorded and ownership updated.")).toBeInTheDocument();
  expect(revalidate).toHaveBeenCalled();
});

test("lets an exact Team admin edit only the name and description", () => {
  renderPage("/business/access/teams/product?section=settings");

  expect(screen.getByLabelText(/Display name/)).toBeInTheDocument();
  expect(screen.getByLabelText("Description")).toBeInTheDocument();
  expect(screen.getAllByText("product")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Preview move" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Archive Team" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete Team" })).not.toBeInTheDocument();
});

test("shows company admin lifecycle entry points and loads move impact preview", async () => {
  vi.mocked(session.useIsAdmin).mockReturnValue(true);
  vi.mocked(teamsApi.confirmTeamMove).mockResolvedValue(PRODUCT);
  vi.mocked(teamsApi.previewTeamMove).mockResolvedValue({
    teamId: PRODUCT.id,
    proposedParentTeamId: "10000000-0000-4000-8000-000000000004",
    teamRevision: 3,
    currentAncestorTeamIds: [EVERYONE.id],
    proposedAncestorTeamIds: [EVERYONE.id],
    gainedAncestorTeamIds: ["10000000-0000-4000-8000-000000000004"],
    lostAncestorTeamIds: [EVERYONE.id],
    descendantTeamIds: [CHILD.id],
    identities: [{ principalId: "member", principalKind: "user", directTeamIds: [PRODUCT.id] }],
    roles: {
      gained: [{ sourceTeamId: "10000000-0000-4000-8000-000000000004", id: "ops-reader" }],
      lost: [{ sourceTeamId: EVERYONE.id, id: "company-reader" }],
    },
    grants: {
      gained: [{ sourceTeamId: "10000000-0000-4000-8000-000000000004", id: "grant-new" }],
      lost: [{ sourceTeamId: EVERYONE.id, id: "grant-old" }],
    },
    assets: {
      gained: [
        {
          sourceTeamId: "10000000-0000-4000-8000-000000000004",
          assetType: "agent",
          assetId: "ops-agent",
        },
      ],
      lost: [{ sourceTeamId: EVERYONE.id, assetType: "file", assetId: "company-plan" }],
    },
    accessChanges: [
      {
        principalId: "member",
        gainedRoleIds: ["ops-reader"],
        lostRoleIds: ["company-reader"],
        gainedGrantIds: ["grant-new"],
        lostGrantIds: ["grant-old"],
        gainedAssetIds: ["ops-agent"],
        lostAssetIds: ["company-plan"],
      },
    ],
    previewToken: "x".repeat(32),
    previewExpiresAt: "2026-09-05T01:00:00.000Z",
  });

  const otherParent = {
    ...EVERYONE,
    id: "10000000-0000-4000-8000-000000000004",
    slug: "operations",
    displayName: "Operations",
  };
  const loaderData = data();
  renderPage("/business/access/teams/product?section=settings", {
    ...loaderData,
    teams: [...loaderData.teams, otherParent],
  });

  await userEvent.selectOptions(screen.getByLabelText("Move under"), otherParent.id);
  await userEvent.click(screen.getByRole("button", { name: "Preview move" }));

  expect(teamsApi.previewTeamMove).toHaveBeenCalledWith(PRODUCT.id, otherParent.id, 3);
  const dialog = await screen.findByRole("dialog", { name: "Confirm Team move" });
  expect(within(dialog).getByText(/ops-reader from Operations/)).toBeInTheDocument();
  expect(within(dialog).getByText(/company-reader from Everyone/)).toBeInTheDocument();
  expect(within(dialog).getByText(/agent ops-agent from Operations/)).toBeInTheDocument();
  expect(within(dialog).getByText(/Aarav Shah — gains Role ops-reader/)).toBeInTheDocument();
  expect(within(dialog).getByText(/expires/)).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Confirm move" }));
  expect(teamsApi.confirmTeamMove).toHaveBeenCalledWith(PRODUCT.id, otherParent.id, "x".repeat(32));
  expect(revalidate).toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Archive Team" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete Team" })).not.toBeInTheDocument();
  expect(screen.getByText(/Archive this Team before/)).toBeInTheDocument();
});

test("archives successfully, announces the result, and revalidates the Team", async () => {
  vi.mocked(session.useIsAdmin).mockReturnValue(true);
  vi.mocked(teamsApi.archiveTeam).mockResolvedValue({
    ...PRODUCT,
    status: "archived",
    revision: 4,
    archivedAt: "2026-09-05T02:00:00.000Z",
  });
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=settings");

  await user.click(screen.getByRole("button", { name: "Archive Team" }));
  await user.click(
    within(screen.getByRole("dialog", { name: "Archive Product?" })).getByRole("button", {
      name: "Archive Team",
    })
  );

  expect(await screen.findByText("Team archived.")).toBeInTheDocument();
  expect(revalidate).toHaveBeenCalled();
});

test("archives with a real confirmation and keeps server blockers inside the dialog", async () => {
  vi.mocked(session.useIsAdmin).mockReturnValue(true);
  vi.mocked(teamsApi.archiveTeam).mockRejectedValue(
    new ApiError(409, "Move child Teams before archiving")
  );
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=settings");

  await user.click(screen.getByRole("button", { name: "Archive Team" }));
  const dialog = screen.getByRole("dialog", { name: "Archive Product?" });
  await user.click(within(dialog).getByRole("button", { name: "Archive Team" }));

  expect(teamsApi.archiveTeam).toHaveBeenCalledWith(PRODUCT.id, 3);
  expect(within(dialog).getByRole("alert")).toHaveTextContent("Move child Teams before archiving");
});

test("offers permanent deletion only for an archived Team and returns to the directory", async () => {
  vi.mocked(session.useIsAdmin).mockReturnValue(true);
  vi.mocked(teamsApi.deleteTeam).mockResolvedValue({ status: "ok" });
  const loaderData = data();
  const archived = {
    ...PRODUCT,
    status: "archived" as const,
    revision: 4,
    archivedAt: "2026-09-05T02:00:00.000Z",
  };
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=settings", {
    ...loaderData,
    team: archived,
    directoryTeam: archived,
  });

  expect(screen.queryByRole("button", { name: "Archive Team" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Delete Team" }));
  const dialog = screen.getByRole("dialog", { name: "Delete Product permanently?" });
  await user.click(within(dialog).getByRole("button", { name: "Delete Team permanently" }));

  expect(teamsApi.deleteTeam).toHaveBeenCalledWith(PRODUCT.id, 4);
  expect(await screen.findByText("Team directory")).toBeInTheDocument();
});

test("shows admin recovery only when no active human Team admin remains", async () => {
  vi.mocked(session.useIsAdmin).mockReturnValue(true);
  vi.mocked(teamsApi.recoverTeamAdmin).mockResolvedValue({
    teamId: PRODUCT.id,
    principalId: "member",
    principalKind: "user",
    level: "admin",
    expiresAt: null,
    revision: 3,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T01:00:00.000Z",
  });
  const loaderData = data();
  if (!loaderData.members.ok) throw new Error("expected member fixture");
  loaderData.members.value.direct = loaderData.members.value.direct.filter(
    (member) => member.level !== "admin"
  );
  loaderData.members.value.direct.push({
    membership: "direct",
    sourceTeamId: PRODUCT.id,
    pathTeamIds: [PRODUCT.id],
    principalId: "expired-member",
    principalKind: "user",
    level: "member",
    expiresAt: "2000-01-01T00:00:00.000Z",
    removable: true,
    revision: 1,
  });
  loaderData.users.value.push(
    {
      id: "expired-member",
      email: "expired@example.com",
      name: "Expired Member",
      role: "member",
      status: "active",
    },
    {
      id: "active-outsider",
      email: "outsider@example.com",
      name: "Active Outsider",
      role: "member",
      status: "active",
    }
  );
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=settings", loaderData);

  await user.click(screen.getByRole("button", { name: "Recover Team admin" }));
  const dialog = screen.getByRole("dialog", { name: "Recover Team admin access" });
  expect(
    within(dialog)
      .getAllByRole("option")
      .map((option) => option.textContent)
  ).toEqual(["Choose an active direct member…", "Aarav Shah"]);
  await user.selectOptions(within(dialog).getByLabelText(/New Team admin/), "member");
  await user.click(within(dialog).getByRole("button", { name: "Recover Team admin" }));

  expect(teamsApi.recoverTeamAdmin).toHaveBeenCalledWith(PRODUCT.id, "member", 3);
  expect(await screen.findByText("Team admin access recovered.")).toBeInTheDocument();
});

test("does not treat a company admin as an implicit exact Team admin", () => {
  vi.mocked(session.useIsAdmin).mockReturnValue(true);
  vi.mocked(session.useSessionUser).mockReturnValue({
    id: "company-admin",
    email: "company@example.com",
    name: "Company Admin",
    role: "admin",
    status: "active",
    navigation: { visiblePaths: [] },
  });
  renderPage("/business/access/teams/product?section=settings");

  expect(screen.getByText(/Only an exact Team admin can edit/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save details" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Archive Team" })).toBeInTheDocument();
});

test("hides recovery when no active direct person can become Team admin", () => {
  vi.mocked(session.useIsAdmin).mockReturnValue(true);
  const loaderData = data();
  if (!loaderData.members.ok) throw new Error("expected member fixture");
  loaderData.members.value.direct = loaderData.members.value.direct.filter(
    (member) => member.principalKind !== "user"
  );
  renderPage("/business/access/teams/product?section=settings", loaderData);

  expect(screen.queryByRole("button", { name: "Recover Team admin" })).not.toBeInTheDocument();
});

test("lets a company admin add Team members without exact Team admin membership", async () => {
  vi.mocked(session.useIsAdmin).mockReturnValue(true);
  vi.mocked(session.useSessionUser).mockReturnValue({
    id: "company-admin",
    email: "company@example.com",
    name: "Company Admin",
    role: "admin",
    status: "active",
    navigation: { visiblePaths: [] },
  });
  vi.mocked(teamsApi.addTeamMembers).mockResolvedValue({
    results: [{ principalId: "new-person", ok: true }],
  });
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=members");

  await user.click(screen.getByRole("button", { name: "Add members" }));
  const dialog = screen.getByRole("dialog", { name: "Add Team members" });
  await user.type(within(dialog).getByLabelText(/Principal IDs/), "new-person");
  await user.click(within(dialog).getByRole("button", { name: "Add members" }));

  expect(teamsApi.addTeamMembers).toHaveBeenCalledWith(PRODUCT.id, [
    { principalId: "new-person", level: "member" },
  ]);
});

test("filters one member table and protects inherited, non-human, and final-admin rows", async () => {
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=members");

  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(screen.getByText("Support Agent")).toBeInTheDocument();
  expect(screen.getByText("Deploy bot")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "from Design" })).toHaveAttribute(
    "href",
    "/teams/design?section=members"
  );
  expect(screen.getByText("Manage in source Team")).toBeInTheDocument();

  const finalAdminRow = screen.getByText("Final Team admin").closest("tr");
  expect(finalAdminRow).not.toBeNull();
  expect(
    within(finalAdminRow as HTMLElement).getByRole("button", { name: "Demote" })
  ).toBeDisabled();
  expect(
    within(finalAdminRow as HTMLElement).getByRole("button", { name: "Remove" })
  ).toBeDisabled();

  const agentRow = screen.getByText("Support Agent").closest("tr");
  expect(agentRow).not.toBeNull();
  expect(within(agentRow as HTMLElement).getByText("People only can be Team admins")).toBeVisible();
  expect(within(agentRow as HTMLElement).getByRole("button", { name: "Promote" })).toBeDisabled();

  await user.click(screen.getByLabelText("Agents"));
  expect(screen.getByText("Support Agent")).toBeInTheDocument();
  expect(within(screen.getByRole("table")).queryByText("Aarav Shah")).not.toBeInTheDocument();
});

test("adds members in bulk and reports every partial validation error", async () => {
  vi.mocked(teamsApi.addTeamMembers).mockResolvedValue({
    results: [
      { principalId: "new-person", ok: true },
      { principalId: "agent-two", ok: false, error: "Agents cannot be Team admins" },
    ],
  });
  renderPage("/business/access/teams/product?section=members");

  fireEvent.click(screen.getByRole("button", { name: "Add members" }));
  const dialog = screen.getByRole("dialog", { name: "Add Team members" });
  fireEvent.change(within(dialog).getByLabelText(/Principal IDs/), {
    target: { value: "new-person\nagent-two" },
  });
  fireEvent.change(within(dialog).getByLabelText("Membership level"), {
    target: { value: "admin" },
  });
  const submit = within(dialog).getByRole("button", { name: "Add members" });
  const form = submit.closest("form");
  if (!form) throw new Error("missing add members form");
  await act(async () => {
    fireEvent.submit(form);
    await Promise.resolve();
  });

  expect(teamsApi.addTeamMembers).toHaveBeenCalledWith(PRODUCT.id, [
    { principalId: "new-person", level: "admin" },
    { principalId: "agent-two", level: "admin" },
  ]);
  const summary = screen.getByRole("alert");
  expect(summary).toHaveTextContent("Some members were not changed.");
  expect(summary).toHaveTextContent("agent-two: Agents cannot be Team admins");
  expect(summary).toHaveFocus();
});

test("bulk-removes only eligible direct members and keeps partial failures selected", async () => {
  vi.mocked(teamsApi.removeTeamMembers).mockResolvedValue({
    results: [
      { principalId: "member", ok: true },
      { principalId: "agent-one", ok: false, error: "Membership changed. Refresh and try again." },
    ],
  });
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=members");

  await user.click(screen.getByLabelText("Select Aarav Shah"));
  await user.click(screen.getByLabelText("Select Support Agent"));
  await user.click(screen.getByRole("button", { name: "Remove selected (2)" }));
  await user.click(screen.getByRole("button", { name: "Remove selected" }));

  expect(teamsApi.removeTeamMembers).toHaveBeenCalledWith(PRODUCT.id, [
    { principalId: "member", revision: 2 },
    { principalId: "agent-one", revision: 1 },
  ]);
  expect(await screen.findByText(/1 removed. 1 could not be removed/)).toBeInTheDocument();
  expect(screen.getByText(/Membership changed. Refresh and try again/)).toBeInTheDocument();
});

test("promotes a person and extends a direct membership expiry with its revision", async () => {
  vi.mocked(teamsApi.updateTeamMember).mockResolvedValue({
    teamId: PRODUCT.id,
    principalId: "member",
    principalKind: "user",
    level: "admin",
    expiresAt: null,
    revision: 3,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T01:00:00.000Z",
  });
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=members");
  const row = within(screen.getByRole("table")).getByText("Aarav Shah").closest("tr");
  if (!row) throw new Error("missing member row");

  await user.click(within(row).getByRole("button", { name: "Promote" }));
  expect(teamsApi.updateTeamMember).toHaveBeenCalledWith(PRODUCT.id, "member", {
    level: "admin",
    expiresAt: "2026-10-01T00:00:00.000Z",
    revision: 2,
  });

  await user.click(within(row).getByRole("button", { name: "Extend expiry" }));
  const dialog = screen.getByRole("dialog", { name: "Extend expiry for Aarav Shah" });
  fireEvent.change(within(dialog).getByLabelText("New expiry"), {
    target: { value: "2026-11-01T12:00" },
  });
  await user.click(within(dialog).getByRole("button", { name: "Save expiry" }));
  expect(teamsApi.updateTeamMember).toHaveBeenLastCalledWith(PRODUCT.id, "member", {
    level: "member",
    expiresAt: new Date("2026-11-01T12:00").toISOString(),
    revision: 2,
  });
});

test("removes one eligible direct member after confirmation", async () => {
  vi.mocked(teamsApi.removeTeamMember).mockResolvedValue({ status: "ok" });
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=members");
  const row = within(screen.getByRole("table")).getByText("Aarav Shah").closest("tr");
  if (!row) throw new Error("missing member row");

  await user.click(within(row).getByRole("button", { name: "Remove" }));
  const dialog = screen.getByRole("dialog", { name: "Remove member?" });
  expect(within(dialog).getByText(/Remove Aarav Shah from Product/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Remove member" }));
  expect(teamsApi.removeTeamMember).toHaveBeenCalledWith(PRODUCT.id, "member", 2);
});

test("lets Team admins approve leave requests and members create them", async () => {
  vi.mocked(teamsApi.decideTeamLeave).mockResolvedValue({
    ...data().leaveRequests.value.requests[0],
    status: "approved",
    revision: 2,
    decidedAt: "2026-09-05T01:00:00.000Z",
    decidedByPrincipalId: "team-admin",
  });
  const admin = userEvent.setup();
  const first = renderPage("/business/access/teams/product?section=members");
  await admin.click(screen.getByRole("button", { name: "Approve" }));
  expect(teamsApi.decideTeamLeave).toHaveBeenCalledWith(
    PRODUCT.id,
    "30000000-0000-4000-8000-000000000001",
    "approved",
    1
  );

  first.unmount();
  vi.clearAllMocks();
  vi.mocked(session.useSessionUser).mockReturnValue({
    id: "member",
    email: "aarav@example.com",
    name: "Aarav Shah",
    role: "member",
    status: "active",
    navigation: { visiblePaths: [] },
  });
  vi.mocked(teamsApi.requestTeamLeave).mockResolvedValue(data().leaveRequests.value.requests[0]);
  const member = userEvent.setup();
  renderPage("/business/access/teams/product?section=members");
  await member.click(screen.getByRole("button", { name: "Request to leave" }));
  expect(teamsApi.requestTeamLeave).toHaveBeenCalledWith(PRODUCT.id);
  expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
});

test("keeps leave requests available when security details are restricted", async () => {
  vi.mocked(session.useSessionUser).mockReturnValue({
    id: "member",
    email: "aarav@example.com",
    name: "Aarav Shah",
    role: "member",
    status: "active",
    navigation: { visiblePaths: [] },
  });
  vi.mocked(teamsApi.requestTeamLeave).mockResolvedValue(data().leaveRequests.value.requests[0]);
  const user = userEvent.setup();

  renderPage("/business/access/teams/product?section=members", data({ partial: true }));
  expect(screen.getByText("Membership details are unavailable or restricted.")).toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Request to leave" }));
  expect(teamsApi.requestTeamLeave).toHaveBeenCalledWith(PRODUCT.id);
});

test("separates direct and inherited authority and links inherited sources", () => {
  const loaderData = data();
  if (!loaderData.authority.ok) throw new Error("Expected authority fixture");
  renderPage("/business/access/teams/product?section=roles", {
    ...loaderData,
    authority: {
      ok: true,
      value: {
        ...loaderData.authority.value,
        inheritedRoles: [
          {
            source: "inherited" as const,
            sourceTeamId: EVERYONE.id,
            pathTeamIds: [PRODUCT.id, EVERYONE.id],
            roleId: "team-reader",
            expiresAt: null,
            assignedAt: "2026-09-05T00:00:00.000Z",
          },
        ] satisfies teamsApi.TeamRole[],
        inheritedGrants: [
          {
            source: "inherited" as const,
            sourceTeamId: EVERYONE.id,
            pathTeamIds: [PRODUCT.id, EVERYONE.id],
            id: "20000000-0000-4000-8000-000000000001",
            action: "record.delete",
            resourceType: "ticket",
            effect: "deny" as const,
            domain: null,
            recordSelector: null,
            fieldSelector: null,
            dataClass: null,
            destination: null,
            conditions: null,
            expiresAt: null,
            createdAt: "2026-09-05T00:00:00.000Z",
            updatedAt: "2026-09-05T00:00:00.000Z",
          },
        ] satisfies teamsApi.TeamGrant[],
      },
    },
  });

  expect(screen.getByRole("region", { name: "Direct Roles" })).toHaveTextContent("People & Teams");
  const inherited = screen.getByRole("region", { name: "Inherited Roles" });
  expect(inherited).toHaveTextContent("Read-only");
  expect(within(inherited).getByRole("link", { name: "Everyone" })).toHaveAttribute(
    "href",
    "/teams/everyone?section=roles"
  );
  expect(screen.getByRole("region", { name: "Inherited grants" })).toHaveTextContent("deny");
});

test("limits a Team admin to delegated Team Roles and grant scopes", async () => {
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=roles");

  const roleSelect = screen.getByLabelText(/Team-compatible Role/);
  expect(
    within(roleSelect)
      .getAllByRole("option")
      .map((option) => option.textContent)
  ).toEqual(["Choose one…", "Team reader — Teams"]);
  expect(screen.queryByText("Team admin delegation")).not.toBeInTheDocument();

  await user.selectOptions(
    screen.getByLabelText(/Delegated grant scope/),
    "record.read\u0000ticket"
  );
  await user.click(screen.getByRole("button", { name: "Add grant" }));
  expect(teamsApi.addTeamGrant).toHaveBeenCalledWith(PRODUCT.id, {
    action: "record.read",
    resourceType: "ticket",
    effect: "allow",
  });
});

test("lets a company admin edit delegation and excludes invalid Role targets", async () => {
  vi.mocked(session.useIsAdmin).mockReturnValue(true);
  const user = userEvent.setup();
  renderPage("/business/access/teams/product?section=roles");

  expect(screen.queryByLabelText("People only")).not.toBeInTheDocument();
  expect(screen.getByLabelText(/Product editor/)).toBeInTheDocument();
  expect(screen.getByLabelText(/Team reader/)).toBeInTheDocument();
  await user.click(screen.getByLabelText(/Product editor/));
  await user.click(screen.getByRole("button", { name: "Save delegation policy" }));

  expect(teamsApi.updateTeamDelegationPolicy).toHaveBeenCalledWith(
    PRODUCT.id,
    expect.objectContaining({
      allowedRoleIds: ["team-reader", "product-editor"],
      allowedGrantScopes: [{ actions: ["record.read"], resourceTypes: ["ticket"] }],
      revision: 2,
    })
  );
});
