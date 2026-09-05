import { describe, expect, it } from "vitest";
import {
  AssetOwnershipAccessService,
  AssetOwnershipError,
  type AssetOwnershipRecord,
  type AssetOwnershipRepoPort,
  AssetOwnershipService,
  type OwnershipApprovalPort,
  type OwnershipApprovalRecord,
  type OwnershipFact,
  projectAssetAccess,
} from "./asset-ownership";
import { type ResolvedTeamMember, TeamServiceError } from "./teams";

const NOW = new Date("2026-09-05T12:00:00.000Z");
const EXPIRES_AT = new Date("2026-09-05T13:00:00.000Z");

function ownership(overrides: Partial<AssetOwnershipRecord> = {}): AssetOwnershipRecord {
  return {
    businessId: "business-1",
    assetType: "agent",
    assetId: "agent-1",
    owners: [
      { kind: "team", teamId: "team-parent" },
      { kind: "team", teamId: "team-peer" },
    ],
    shares: [],
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function member(
  principalId: string,
  sourceTeamId: string,
  level: "member" | "admin",
  pathTeamIds: readonly string[]
): ResolvedTeamMember {
  return {
    membership: pathTeamIds.length === 1 ? "direct" : "inherited",
    sourceTeamId,
    pathTeamIds,
    principalId,
    principalKind: "user",
    level,
    removable: pathTeamIds.length === 1,
    revision: 1,
  };
}

describe("projectAssetAccess", () => {
  it("gives owner members View and Use, but Edit only to exact human owner-Team admins", async () => {
    const memberships = {
      async resolveMembers(_businessId: string, teamId: string) {
        if (teamId !== "team-parent") return [];
        return [
          member("member", "team-parent", "member", ["team-parent"]),
          member("owner-admin", "team-parent", "admin", ["team-parent"]),
          member("child-admin", "team-child", "admin", ["team-child", "team-parent"]),
        ];
      },
    };

    await expect(
      projectAssetAccess(ownership(), { principalId: "member", principalKind: "user" }, memberships)
    ).resolves.toMatchObject({ levels: ["view", "use"], canManageOwnership: false });
    await expect(
      projectAssetAccess(
        ownership(),
        { principalId: "owner-admin", principalKind: "user" },
        memberships
      )
    ).resolves.toMatchObject({
      levels: ["view", "use", "edit"],
      canManageOwnership: true,
    });
    await expect(
      projectAssetAccess(
        ownership(),
        { principalId: "child-admin", principalKind: "user" },
        memberships
      )
    ).resolves.toMatchObject({ levels: ["view", "use"], canManageOwnership: false });
  });

  it("prefers an exact direct admin membership over an inherited membership for the same person", async () => {
    const memberships = {
      async resolveMembers(_businessId: string, teamId: string) {
        if (teamId !== "team-parent") return [];
        return [
          member("owner-admin", "00000000-0000-4000-8000-000000000000", "member", [
            "00000000-0000-4000-8000-000000000000",
            "team-parent",
          ]),
          member("owner-admin", "team-parent", "admin", ["team-parent"]),
        ];
      },
    };

    await expect(
      projectAssetAccess(
        ownership(),
        { principalId: "owner-admin", principalKind: "user" },
        memberships
      )
    ).resolves.toMatchObject({
      levels: ["view", "use", "edit"],
      canManageOwnership: true,
      evidence: [
        {
          source: "team_owner",
          teamId: "team-parent",
          access: "edit",
          inherited: false,
        },
      ],
    });
  });

  it("does not grant management through an expired exact admin membership", async () => {
    const memberships = {
      async resolveMembers() {
        return [
          {
            ...member("owner-admin", "team-parent", "admin", ["team-parent"]),
            expiresAt: NOW,
          },
        ];
      },
    };

    await expect(
      projectAssetAccess(
        ownership(),
        { principalId: "owner-admin", principalKind: "user" },
        memberships,
        NOW
      )
    ).resolves.toMatchObject({ levels: [], canManageOwnership: false });
  });

  it("flows Team shares to descendants at the selected level", async () => {
    const record = ownership({
      owners: [{ kind: "team", teamId: "team-peer" }],
      shares: [{ teamId: "team-parent", access: "edit" }],
    });

    const memberships = {
      async resolveMembers(_businessId: string, teamId: string) {
        return teamId === "team-parent"
          ? [member("child-member", "team-child", "member", ["team-child", "team-parent"])]
          : [];
      },
    };

    await expect(
      projectAssetAccess(
        record,
        { principalId: "child-member", principalKind: "user" },
        memberships
      )
    ).resolves.toMatchObject({
      levels: ["view", "use", "edit"],
      canManageOwnership: false,
    });
  });

  it.each(["agent", "skill", "routine"] as const)(
    "applies descendant View and Use with explicit Edit for %s assets",
    async (assetType) => {
      const record = ownership({
        assetType,
        owners: [{ kind: "team", teamId: "team-parent" }],
        shares: [{ teamId: "team-child", access: "edit" }],
      });
      const memberships = {
        async resolveMembers(_businessId: string, teamId: string) {
          if (teamId === "team-parent") {
            return [member("descendant", "team-child", "admin", ["team-child", "team-parent"])];
          }
          if (teamId === "team-child") {
            return [member("descendant", "team-child", "admin", ["team-child"])];
          }
          return [];
        },
      };

      const access = await projectAssetAccess(
        record,
        { principalId: "descendant", principalKind: "user" },
        memberships
      );
      expect(access.levels).toEqual(["view", "use", "edit"]);
      expect(access.canManageOwnership).toBe(false);
      expect(access).not.toHaveProperty("roles");
      expect(access).not.toHaveProperty("grants");
    }
  );

  it("allows personal ownership only for Files and Knowledge", async () => {
    const memberships = {
      async resolveMembers() {
        return [];
      },
    };
    const personal = ownership({
      assetType: "file",
      owners: [{ kind: "principal", principalId: "person-1", principalKind: "user" }],
    });

    await expect(
      projectAssetAccess(personal, { principalId: "person-1", principalKind: "user" }, memberships)
    ).resolves.toMatchObject({
      levels: ["view", "use", "edit"],
      canManageOwnership: true,
    });
  });
});

class MemoryOwnershipRepo implements AssetOwnershipRepoPort {
  record = ownership();
  operation: Parameters<AssetOwnershipRepoPort["createOperation"]>[0] | undefined;
  approvals?: MemoryApprovals;

  async create(record: AssetOwnershipRecord) {
    this.record = record;
  }

  async get() {
    return this.record;
  }

  async put(record: AssetOwnershipRecord, expectedRevision: number) {
    if (this.record.revision !== expectedRevision) {
      throw new AssetOwnershipError("conflict", "revision conflict");
    }
    this.record = record;
  }

  async delete() {}

  async createOperation(operation: Parameters<AssetOwnershipRepoPort["createOperation"]>[0]) {
    this.operation = operation;
  }

  async createOperationWithApproval(
    operation: Parameters<AssetOwnershipRepoPort["createOperationWithApproval"]>[0],
    approval: Parameters<AssetOwnershipRepoPort["createOperationWithApproval"]>[1]
  ) {
    if (!this.approvals) throw new Error("missing Approval repository");
    await this.approvals.create(approval);
    this.operation = operation;
  }

  async getOperation() {
    return this.operation;
  }

  async listOperations() {
    return this.operation === undefined ? [] : [this.operation];
  }

  async completeApprovedOperation(
    input: Parameters<AssetOwnershipRepoPort["completeApprovedOperation"]>[0]
  ) {
    if (
      !this.operation ||
      this.operation.id !== input.operationId ||
      this.operation.status !== "pending"
    ) {
      throw new AssetOwnershipError("conflict", "operation revision conflict");
    }
    if (this.record.revision !== this.operation.expectedOwnershipRevision) {
      throw new AssetOwnershipError("stale", "ownership revision conflict");
    }
    if (!this.approvals) throw new Error("missing Approval repository");
    await this.approvals.consume(
      input.businessId,
      this.operation.approvalId,
      input.binding,
      input.at
    );
    if (input.updatedOwnership) this.record = input.updatedOwnership;
    this.operation = {
      ...this.operation,
      status: "completed",
      revision: this.operation.revision + 1,
      completedAt: input.at,
    };
    return { ownership: this.record, operation: this.operation };
  }

  async completeEmergencyOperation(
    input: Parameters<AssetOwnershipRepoPort["completeEmergencyOperation"]>[0]
  ) {
    if (
      !this.operation ||
      this.operation.id !== input.operationId ||
      this.operation.status !== "pending"
    ) {
      throw new AssetOwnershipError("conflict", "operation revision conflict");
    }
    if (this.record.revision !== this.operation.expectedOwnershipRevision) {
      throw new AssetOwnershipError("stale", "ownership revision conflict");
    }
    if (input.updatedOwnership) this.record = input.updatedOwnership;
    this.operation = {
      ...this.operation,
      status: "completed",
      revision: this.operation.revision + 1,
      completedAt: input.at,
    };
    return { ownership: this.record, operation: this.operation };
  }
}

describe("AssetOwnershipAccessService", () => {
  it.each([
    ["inactive", "owner", new TeamServiceError("invalid", "Team is archived")],
    ["missing", "owner", new TeamServiceError("not_found", "Team was not found")],
    ["inactive", "share", new TeamServiceError("invalid", "Team is archived")],
    ["missing", "share", new TeamServiceError("not_found", "Team was not found")],
  ])(
    "ignores an %s %s Team without breaking access through a valid owner",
    async (_state, relation, staleTeamError) => {
      const repo = new MemoryOwnershipRepo();
      const record =
        relation === "owner"
          ? ownership({
              owners: [
                { kind: "team", teamId: "team-stale" },
                { kind: "team", teamId: "team-valid" },
              ],
            })
          : ownership({
              owners: [{ kind: "team", teamId: "team-valid" }],
              shares: [{ teamId: "team-stale", access: "edit" }],
            });
      const access = new AssetOwnershipAccessService({
        ownership: repo,
        memberships: {
          async resolveMembers(_businessId, teamId) {
            if (teamId === "team-stale") throw staleTeamError;
            return [member("valid-member", "team-valid", "member", ["team-valid"])];
          },
        },
        everyoneTeamId: async () => "team-valid",
        now: () => NOW,
      });

      await expect(
        access.accessFor(record, { principalId: "valid-member", principalKind: "user" })
      ).resolves.toMatchObject({
        levels: ["view", "use"],
        canManageOwnership: false,
        evidence: [
          {
            source: "team_owner",
            teamId: "team-valid",
            access: "use",
            inherited: false,
          },
        ],
      });
      await expect(
        access.accessFor(record, { principalId: "stale-member", principalKind: "user" })
      ).resolves.toMatchObject({
        levels: [],
        canManageOwnership: false,
        evidence: [],
      });
    }
  );
});

class MemoryApprovals implements OwnershipApprovalPort {
  record?: OwnershipApprovalRecord;

  async create(record: Parameters<OwnershipApprovalPort["create"]>[0]) {
    this.record = { ...record, decisions: [] };
    return this.record;
  }

  async get() {
    return this.record;
  }

  async appendDecision(
    _businessId: string,
    _approvalId: string,
    decision: OwnershipApprovalRecord["decisions"][number]
  ) {
    if (!this.record) throw new Error("missing Approval");
    if (this.record.expiresAt <= decision.decidedAt) {
      throw new AssetOwnershipError("expired", "expired");
    }
    if (
      this.record.decisions.some(
        (entry) => entry.approverPrincipalId === decision.approverPrincipalId
      )
    ) {
      throw new AssetOwnershipError("duplicate_decision", "duplicate decision");
    }
    this.record = { ...this.record, decisions: [...this.record.decisions, decision] };
    return this.record;
  }

  async consume(
    _businessId: string,
    _approvalId: string,
    binding: OwnershipApprovalRecord["binding"],
    at: Date
  ) {
    if (!this.record) throw new Error("missing Approval");
    if (this.record.consumedAt) throw new AssetOwnershipError("already_completed", "consumed");
    if (this.record.expiresAt <= at) throw new AssetOwnershipError("expired", "expired");
    if (
      this.record.binding.intentDigest !== binding.intentDigest ||
      this.record.binding.evidenceDigest !== binding.evidenceDigest ||
      this.record.binding.guardrailRevision !== binding.guardrailRevision
    ) {
      throw new AssetOwnershipError("stale", "stale");
    }
    for (const role of this.record.requiredApproverRoles) {
      if (
        !this.record.decisions.some(
          (decision) => decision.outcome === "approved" && decision.satisfiedApproverRole === role
        )
      ) {
        throw new AssetOwnershipError("pending_approval", "pending");
      }
    }
    this.record = { ...this.record, consumedAt: at };
    return this.record;
  }
}

function service() {
  const repo = new MemoryOwnershipRepo();
  const approvals = new MemoryApprovals();
  repo.approvals = approvals;
  const facts: OwnershipFact[] = [];
  const instance = new AssetOwnershipService({
    ownership: repo,
    approvals,
    memberships: {
      async resolveMembers(_businessId, teamId) {
        return [
          member(`${teamId}-admin`, teamId, "admin", [teamId]),
          member("company-admin", teamId, "member", [teamId]),
        ];
      },
    },
    facts: {
      async emit(fact) {
        facts.push(fact);
      },
    },
    now: () => NOW,
    newId: () => "operation-1",
  });
  return { instance, repo, approvals, facts };
}

describe("AssetOwnershipService", () => {
  it("rejects ownerless shared assets and personal ownership on business asset types", async () => {
    const { instance } = service();
    await expect(
      instance.create({
        businessId: "business-1",
        assetType: "skill",
        assetId: "skill-1",
        owners: [],
        shares: [],
      })
    ).rejects.toMatchObject({ reason: "invalid_ownership" });
    await expect(
      instance.create({
        businessId: "business-1",
        assetType: "routine",
        assetId: "routine-1",
        owners: [{ kind: "principal", principalId: "person-1", principalKind: "user" }],
        shares: [],
      })
    ).rejects.toMatchObject({ reason: "invalid_ownership" });
  });

  it("refuses to add a Team owner to a personally owned File", async () => {
    // `create` rejects an owner set holding both a person and a Team, so `add_owner` must not be a
    // way in through the side door: it would leave the File owned by a person and a Team at once,
    // and there is no operation that can put it back.
    const { instance } = service();
    const owned = await instance.create({
      businessId: "business-1",
      assetType: "file",
      assetId: "file-personal",
      owners: [{ kind: "principal", principalId: "person-1", principalKind: "user" }],
      shares: [],
    });

    await expect(
      instance.propose({
        businessId: "business-1",
        assetType: "file",
        assetId: "file-personal",
        action: "add_owner",
        teamId: "team-new",
        expectedRevision: owned.revision,
        proposerPrincipalId: "person-1",
        actor: {
          principalId: "person-1",
          principalKind: "user",
          companyAdmin: false,
          administeredTeamIds: [],
        },
        expiresAt: EXPIRES_AT,
      })
    ).rejects.toMatchObject({ reason: "invalid_ownership" });
  });

  it("requires every current owner and the new owner to approve a co-owner proposal", async () => {
    const { instance, approvals } = service();
    const operation = await instance.propose({
      businessId: "business-1",
      assetType: "agent",
      assetId: "agent-1",
      action: "add_owner",
      teamId: "team-new",
      expectedRevision: 1,
      proposerPrincipalId: "proposer",
      actor: {
        principalId: "team-parent-admin",
        principalKind: "user",
        companyAdmin: false,
        administeredTeamIds: ["team-parent"],
      },
      expiresAt: EXPIRES_AT,
    });

    expect(approvals.record?.requiredApproverRoles).toEqual([
      "team:team-parent:admin",
      "team:team-peer:admin",
      "team:team-new:admin",
    ]);

    for (const teamId of ["team-parent", "team-peer", "team-new"]) {
      await instance.decide({
        businessId: "business-1",
        operationId: operation.id,
        actor: {
          principalId: `${teamId}-admin`,
          principalKind: "user",
          companyAdmin: false,
          administeredTeamIds: [teamId],
        },
        representedTeamId: teamId,
        outcome: "approved",
      });
    }
    await expect(instance.complete("business-1", operation.id)).resolves.toMatchObject({
      revision: 2,
      owners: expect.arrayContaining([{ kind: "team", teamId: "team-new" }]),
    });
  });

  it("rejects unauthorized, duplicate, expired, and stale decisions", async () => {
    const { instance, repo } = service();
    const operation = await instance.propose({
      businessId: "business-1",
      assetType: "agent",
      assetId: "agent-1",
      action: "remove_owner",
      teamId: "team-peer",
      expectedRevision: 1,
      proposerPrincipalId: "proposer",
      actor: {
        principalId: "team-parent-admin",
        principalKind: "user",
        companyAdmin: false,
        administeredTeamIds: ["team-parent"],
      },
      expiresAt: EXPIRES_AT,
    });
    await expect(
      instance.decide({
        businessId: "business-1",
        operationId: operation.id,
        actor: {
          principalId: "child-admin",
          principalKind: "user",
          companyAdmin: false,
          administeredTeamIds: ["team-child"],
        },
        representedTeamId: "team-parent",
        outcome: "approved",
      })
    ).rejects.toMatchObject({ reason: "forbidden" });

    const decision = {
      businessId: "business-1",
      operationId: operation.id,
      actor: {
        principalId: "team-parent-admin",
        principalKind: "user" as const,
        companyAdmin: false,
        administeredTeamIds: ["team-parent"],
      },
      representedTeamId: "team-parent",
      outcome: "approved" as const,
    };
    await instance.decide(decision);
    await expect(instance.decide(decision)).rejects.toMatchObject({
      reason: "duplicate_decision",
    });

    repo.record = { ...repo.record, revision: 2 };
    await expect(instance.complete("business-1", operation.id)).rejects.toMatchObject({
      reason: "stale",
    });
  });

  it("rejects a decision at the Approval expiry instant", async () => {
    const { instance } = service();
    const operation = await instance.propose({
      businessId: "business-1",
      assetType: "agent",
      assetId: "agent-1",
      action: "archive",
      expectedRevision: 1,
      proposerPrincipalId: "proposer",
      actor: {
        principalId: "team-parent-admin",
        principalKind: "user",
        companyAdmin: false,
        administeredTeamIds: ["team-parent"],
      },
      expiresAt: NOW,
    });
    await expect(
      instance.decide({
        businessId: "business-1",
        operationId: operation.id,
        actor: {
          principalId: "team-parent-admin",
          principalKind: "user",
          companyAdmin: false,
          administeredTeamIds: ["team-parent"],
        },
        representedTeamId: "team-parent",
        outcome: "approved",
      })
    ).rejects.toMatchObject({ reason: "expired" });
  });

  it("lets only one concurrent completion win", async () => {
    const { instance } = service();
    const operation = await instance.propose({
      businessId: "business-1",
      assetType: "agent",
      assetId: "agent-1",
      action: "remove_owner",
      teamId: "team-peer",
      expectedRevision: 1,
      proposerPrincipalId: "proposer",
      actor: {
        principalId: "team-parent-admin",
        principalKind: "user",
        companyAdmin: false,
        administeredTeamIds: ["team-parent"],
      },
      expiresAt: EXPIRES_AT,
    });
    for (const teamId of ["team-parent", "team-peer"]) {
      await instance.decide({
        businessId: "business-1",
        operationId: operation.id,
        actor: {
          principalId: `${teamId}-admin`,
          principalKind: "user",
          companyAdmin: false,
          administeredTeamIds: [teamId],
        },
        representedTeamId: teamId,
        outcome: "approved",
      });
    }

    const results = await Promise.allSettled([
      instance.complete("business-1", operation.id),
      instance.complete("business-1", operation.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("requires a reason for company-admin override and emits a high-visibility fact", async () => {
    const { instance, facts, repo } = service();
    const actor = {
      principalId: "company-admin",
      principalKind: "user" as const,
      companyAdmin: true,
      administeredTeamIds: [],
    };
    const operation = await instance.propose({
      businessId: "business-1",
      assetType: "agent",
      assetId: "agent-1",
      action: "add_owner",
      teamId: "team-emergency",
      expectedRevision: 1,
      proposerPrincipalId: "proposer",
      actor: {
        principalId: "team-parent-admin",
        principalKind: "user",
        companyAdmin: false,
        administeredTeamIds: ["team-parent"],
      },
      expiresAt: EXPIRES_AT,
    });
    facts.length = 0;
    await expect(
      instance.emergencyOverride({
        businessId: "business-1",
        assetType: "agent",
        assetId: "agent-1",
        operationId: operation.id,
        actor,
        reason: " ",
      })
    ).rejects.toMatchObject({ reason: "reason_required" });

    await expect(
      instance.emergencyOverride({
        businessId: "business-1",
        assetType: "agent",
        assetId: "different-agent",
        operationId: operation.id,
        actor,
        reason: "Both owner Teams are unavailable during incident recovery.",
      })
    ).rejects.toMatchObject({ reason: "forbidden" });

    const updated = await instance.emergencyOverride({
      businessId: "business-1",
      assetType: "agent",
      assetId: "agent-1",
      operationId: operation.id,
      actor,
      reason: "Both owner Teams are unavailable during incident recovery.",
    });
    expect(updated.owners).toContainEqual({ kind: "team", teamId: "team-emergency" });
    expect(repo.operation).toMatchObject({ status: "completed" });
    expect(facts).toEqual([
      expect.objectContaining({
        action: "asset.ownership.emergency_override",
        highVisibility: true,
        reason: "Both owner Teams are unavailable during incident recovery.",
      }),
    ]);
  });
});
