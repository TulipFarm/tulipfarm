import { afterEach, expect, test, vi } from "vitest";
import {
  addTeamGrant,
  addTeamMembers,
  archiveTeam,
  assignTeamRole,
  completeOwnershipOperation,
  confirmTeamMove,
  createTeam,
  decideTeamLeave,
  deleteTeam,
  deleteTeamGrant,
  emergencyOverrideOwnershipOperation,
  explainTeamAccess,
  getTeamDelegationPolicy,
  listOwnershipApprovals,
  listServiceAccounts,
  listTeamAssets,
  listTeamHierarchy,
  listTeamLeaveRequests,
  listTeams,
  previewTeamMove,
  recoverTeamAdmin,
  removeTeamMember,
  removeTeamMembers,
  requestTeamLeave,
  revokeTeamRole,
  updateTeam,
  updateTeamDelegationPolicy,
  updateTeamMember,
} from "./teams";

afterEach(() => vi.unstubAllGlobals());

test("loads the public Team directory and normalizes a missing member list", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        teams: [
          {
            id: "10000000-0000-4000-8000-000000000001",
            businessId: "business",
            slug: "everyone",
            displayName: "Everyone",
            description: null,
            status: "active",
            parentTeamId: null,
            revision: 1,
            createdAt: "2026-09-05T00:00:00.000Z",
            updatedAt: "2026-09-05T00:00:00.000Z",
            archivedAt: null,
          },
        ],
      })
    )
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(listTeams()).resolves.toEqual({
    teams: [expect.objectContaining({ displayName: "Everyone", members: [] })],
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "http://localhost:4010/api/v1/teams",
    expect.objectContaining({ credentials: "include" })
  );
});

test("loads hierarchy from the canonical Team endpoint", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ teams: [] })));
  vi.stubGlobal("fetch", fetchMock);

  await expect(listTeamHierarchy()).resolves.toEqual({ teams: [] });
  expect(fetchMock).toHaveBeenCalledWith(
    "http://localhost:4010/api/v1/teams/hierarchy",
    expect.objectContaining({ credentials: "include" })
  );
});

test("writes Team creation and editable identity to canonical endpoints", async () => {
  const fetchMock = vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          id: "10000000-0000-4000-8000-000000000001",
          slug: "product",
          displayName: "Product",
        }),
        { status: 200 }
      )
    )
  );
  vi.stubGlobal("fetch", fetchMock);

  await createTeam({
    slug: "product",
    displayName: "Product",
    parentTeamId: "10000000-0000-4000-8000-000000000002",
    initialAdminUserIds: ["user-1"],
  });
  await updateTeam("10000000-0000-4000-8000-000000000001", {
    displayName: "Product and Design",
    revision: 2,
  });

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "http://localhost:4010/api/v1/teams",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        slug: "product",
        displayName: "Product",
        parentTeamId: "10000000-0000-4000-8000-000000000002",
        initialAdminUserIds: ["user-1"],
      }),
    })
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "http://localhost:4010/api/v1/teams/10000000-0000-4000-8000-000000000001",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ displayName: "Product and Design", revision: 2 }),
    })
  );
});

test("loads Team move impact through the T06 preview endpoint", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ previewToken: "x" })));
  vi.stubGlobal("fetch", fetchMock);

  await previewTeamMove(
    "10000000-0000-4000-8000-000000000001",
    "10000000-0000-4000-8000-000000000002",
    3
  );

  expect(fetchMock).toHaveBeenCalledWith(
    "http://localhost:4010/api/v1/teams/10000000-0000-4000-8000-000000000001/move-preview",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        parentTeamId: "10000000-0000-4000-8000-000000000002",
        revision: 3,
      }),
    })
  );
});

test("confirms move, archives, deletes, and recovers an admin with revisions", async () => {
  const teamId = "10000000-0000-4000-8000-000000000001";
  const parentTeamId = "10000000-0000-4000-8000-000000000002";
  const fetchMock = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }))
    );
  vi.stubGlobal("fetch", fetchMock);

  await confirmTeamMove(teamId, parentTeamId, "x".repeat(32));
  await archiveTeam(teamId, 4);
  await deleteTeam(teamId, 5);
  await recoverTeamAdmin(teamId, "person-1", 6);

  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
    [
      `http://localhost:4010/api/v1/teams/${teamId}/move`,
      "POST",
      JSON.stringify({ parentTeamId, previewToken: "x".repeat(32) }),
    ],
    [
      `http://localhost:4010/api/v1/teams/${teamId}/archive`,
      "POST",
      JSON.stringify({ revision: 4 }),
    ],
    [`http://localhost:4010/api/v1/teams/${teamId}`, "DELETE", JSON.stringify({ revision: 5 })],
    [
      `http://localhost:4010/api/v1/teams/${teamId}/admin-recovery`,
      "POST",
      JSON.stringify({ principalId: "person-1", revision: 6 }),
    ],
  ]);
});

test("loads the server Team asset catalog with filters and normalizes pending Approvals", async () => {
  const teamId = "10000000-0000-4000-8000-000000000001";
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        items: [
          {
            id: "support",
            type: "agent",
            label: "Support",
            description: null,
            href: "/agents/support",
            lifecycleStatus: "pending",
            source: "owned",
            sourceTeamIds: [teamId],
            effectiveLevels: ["view", "use"],
            canManageOwnership: false,
            ownership: {
              revision: 2,
              owners: [{ kind: "team", teamId }],
              shares: [],
            },
            pendingApprovals: [
              {
                approvalId: "30000000-0000-4000-8000-000000000001",
                operationId: "40000000-0000-4000-8000-000000000001",
                action: "add_owner",
                risk: "high",
                preview: "add owner",
                riskSummary: "Ownership changes",
                status: "pending",
                requiredTeamIds: [teamId],
                decisions: 1,
                requiredDecisions: 2,
                readyToComplete: false,
                representedTeamId: teamId,
                canDecide: true,
                expiresAt: "2026-09-12T00:00:00.000Z",
                createdAt: "2026-09-05T00:00:00.000Z",
              },
            ],
          },
        ],
        nextCursor: "next",
      })
    )
  );
  vi.stubGlobal("fetch", fetchMock);

  const result = await listTeamAssets({
    teamId,
    type: "agent",
    source: "owned",
    access: "use",
    ownerTeamId: teamId,
    lifecycleStatus: "pending",
    cursor: "cursor",
    limit: 10,
  });

  expect(fetchMock).toHaveBeenCalledWith(
    `http://localhost:4010/api/v1/teams/${teamId}/assets?type=agent&source=owned&access=use&ownerTeamId=${teamId}&lifecycleStatus=pending&cursor=cursor&limit=10`,
    expect.objectContaining({ credentials: "include" })
  );
  expect(result.items[0]).toEqual(
    expect.objectContaining({
      assetType: "agent",
      effectiveLevels: ["view", "use"],
      canManageOwnership: false,
      approvals: [
        expect.objectContaining({
          assetType: "agent",
          assetId: "support",
          readyToComplete: false,
        }),
      ],
    })
  );
  expect(result.nextCursor).toBe("next");
});

test("preserves redacted Team asset governance without inventing owners or Approvals", async () => {
  const teamId = "10000000-0000-4000-8000-000000000001";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "support",
              type: "agent",
              label: "Support",
              description: null,
              href: "/agents/support",
              lifecycleStatus: "pending",
              source: "owned",
              sourceTeamIds: [],
              effectiveLevels: ["view", "use"],
              canManageOwnership: false,
              ownership: null,
              pendingApprovals: [],
            },
          ],
          nextCursor: null,
        })
      )
    )
  );

  const result = await listTeamAssets({ teamId });

  expect(result.items[0]).toMatchObject({
    ownership: null,
    approvals: [],
    canManageOwnership: false,
  });
});

test("requests a bounded page of Team ownership Approvals", async () => {
  const teamId = "10000000-0000-4000-8000-000000000001";
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ items: [], nextCursor: "next" })));
  vi.stubGlobal("fetch", fetchMock);

  await expect(listOwnershipApprovals(teamId, { cursor: "current", limit: 10 })).resolves.toEqual({
    items: [],
    nextCursor: "next",
  });
  expect(fetchMock).toHaveBeenCalledWith(
    `http://localhost:4010/api/v1/team-assets/approvals?teamId=${teamId}&cursor=current&limit=10`,
    expect.objectContaining({ credentials: "include" })
  );
});

test("uses completion and emergency override endpoints for one ownership operation", async () => {
  const approval = {
    approvalId: "30000000-0000-4000-8000-000000000001",
    operationId: "40000000-0000-4000-8000-000000000001",
    assetType: "agent" as const,
    assetId: "support",
    action: "add_owner" as const,
    risk: "high" as const,
    preview: "add owner",
    riskSummary: "Ownership changes",
    status: "pending" as const,
    requiredTeamIds: [],
    decisions: 1,
    requiredDecisions: 1,
    readyToComplete: true,
    representedTeamId: null,
    canDecide: false,
    expiresAt: "2026-09-12T00:00:00.000Z",
    createdAt: "2026-09-05T00:00:00.000Z",
  };
  const fetchMock = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ revision: 2 }), { status: 200 }))
    );
  vi.stubGlobal("fetch", fetchMock);

  await completeOwnershipOperation(approval);
  await emergencyOverrideOwnershipOperation(approval, "Owners unavailable");

  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.body])).toEqual([
    [
      `http://localhost:4010/api/v1/team-assets/agent/support/operations/${approval.operationId}/complete`,
      JSON.stringify({}),
    ],
    [
      `http://localhost:4010/api/v1/team-assets/agent/support/operations/${approval.operationId}/emergency-override`,
      JSON.stringify({ reason: "Owners unavailable" }),
    ],
  ]);
});

test("uses canonical Team authority, delegation, and explanation endpoints", async () => {
  const teamId = "10000000-0000-4000-8000-000000000001";
  const grantId = "20000000-0000-4000-8000-000000000001";
  const fetchMock = vi
    .fn()
    .mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "DELETE"
          ? new Response(null, { status: 200 })
          : new Response(JSON.stringify({ status: "ok", evidence: [] }))
      )
    );
  vi.stubGlobal("fetch", fetchMock);

  await assignTeamRole(teamId, "team-reader");
  await revokeTeamRole(teamId, "team-reader");
  await addTeamGrant(teamId, {
    action: "record.read",
    resourceType: "ticket",
    effect: "allow",
  });
  await deleteTeamGrant(teamId, grantId);
  await getTeamDelegationPolicy(teamId);
  await updateTeamDelegationPolicy(teamId, {
    allowedRoleIds: ["team-reader"],
    allowedGrantScopes: [{ actions: ["record.read"], resourceTypes: ["ticket"] }],
    revision: 1,
  });
  await explainTeamAccess(teamId, {
    principalId: "user-1",
    action: "record.read",
    resourceType: "ticket",
  });

  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    `http://localhost:4010/api/v1/teams/${teamId}/roles`,
    `http://localhost:4010/api/v1/teams/${teamId}/roles/team-reader`,
    `http://localhost:4010/api/v1/teams/${teamId}/grants`,
    `http://localhost:4010/api/v1/teams/${teamId}/grants/${grantId}`,
    `http://localhost:4010/api/v1/teams/${teamId}/delegation-policy`,
    `http://localhost:4010/api/v1/teams/${teamId}/delegation-policy`,
    `http://localhost:4010/api/v1/teams/${teamId}/access-explanations`,
  ]);
});

test("uses typed Team membership and leave endpoints", async () => {
  const teamId = "10000000-0000-4000-8000-000000000001";
  const requestId = "30000000-0000-4000-8000-000000000001";
  const fetchMock = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ results: [], requests: [], status: "ok" })))
    );
  vi.stubGlobal("fetch", fetchMock);

  await addTeamMembers(teamId, [{ principalId: "person-1", level: "member" }]);
  await updateTeamMember(teamId, "person-1", {
    level: "admin",
    expiresAt: null,
    revision: 2,
  });
  await removeTeamMember(teamId, "person-1", 3);
  await removeTeamMembers(teamId, [{ principalId: "person-2", revision: 1 }]);
  await requestTeamLeave(teamId);
  await listTeamLeaveRequests(teamId);
  await decideTeamLeave(teamId, requestId, "rejected", 1);
  await listServiceAccounts();

  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
    [`http://localhost:4010/api/v1/teams/${teamId}/members/bulk`, "POST"],
    [`http://localhost:4010/api/v1/teams/${teamId}/members/person-1`, "PATCH"],
    [`http://localhost:4010/api/v1/teams/${teamId}/members/person-1`, "DELETE"],
    [`http://localhost:4010/api/v1/teams/${teamId}/members/bulk-remove`, "POST"],
    [`http://localhost:4010/api/v1/teams/${teamId}/leave-requests`, "POST"],
    [`http://localhost:4010/api/v1/teams/${teamId}/leave-requests`, undefined],
    [`http://localhost:4010/api/v1/teams/${teamId}/leave-requests/${requestId}/decision`, "POST"],
    ["http://localhost:4010/api/v1/identity/api-clients", undefined],
  ]);
  expect(fetchMock.mock.calls[2]?.[1]).toEqual(
    expect.objectContaining({ body: JSON.stringify({ revision: 3 }) })
  );
});
