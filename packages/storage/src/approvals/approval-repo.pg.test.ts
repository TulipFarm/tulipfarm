import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTHORIZATION_STORAGE_STATEMENTS } from "../auth/role-repo";
import { TEAM_STORAGE_STATEMENTS } from "../auth/team-repo";
import { transactionPort } from "../pg/test-support";
import { ASSET_OWNERSHIP_APPROVAL_STORAGE_STATEMENTS, PgApprovalGrantRepo } from "./approval-repo";

const TEAM_ONE = "123e4567-e89b-42d3-a456-426614174101";
const TEAM_TWO = "123e4567-e89b-42d3-a456-426614174102";

describe("PgApprovalGrantRepo", () => {
  let database: PGlite;
  let repo: PgApprovalGrantRepo;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of AUTHORIZATION_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    for (const statement of TEAM_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    for (const statement of ASSET_OWNERSHIP_APPROVAL_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    await database.query(
      `INSERT INTO principals (business_id, id, kind, status)
       VALUES
         ('business-1', 'admin-one', 'user', 'active'),
         ('business-1', 'admin-one-backup', 'user', 'active'),
         ('business-1', 'admin-two', 'user', 'active')`
    );
    await database.query(
      `INSERT INTO teams
         (id, business_id, slug, display_name, parent_team_id, status, protected)
       VALUES
         ($1, 'business-1', 'one', 'One',
          (SELECT id FROM teams WHERE business_id = 'business-1' AND slug = 'everyone'),
          'active', false),
         ($2, 'business-1', 'two', 'Two',
          (SELECT id FROM teams WHERE business_id = 'business-1' AND slug = 'everyone'),
          'active', false)`,
      [TEAM_ONE, TEAM_TWO]
    );
    await database.query(
      `INSERT INTO team_memberships (team_id, principal_id, principal_kind, level)
       VALUES
         ($1, 'admin-one', 'user', 'admin'),
         ($1, 'admin-one-backup', 'user', 'admin'),
         ($2, 'admin-two', 'user', 'admin')`,
      [TEAM_ONE, TEAM_TWO]
    );
    repo = new PgApprovalGrantRepo(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  it("persists one decision per owner Team and consumes unanimous Approval once", async () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    const binding = {
      intentDigest: "intent",
      evidenceDigest: "evidence",
      guardrailRevision: "asset-ownership-v1",
    };
    await repo.create({
      approvalId: "123e4567-e89b-42d3-a456-426614174000",
      businessId: "business-1",
      binding,
      risk: "high",
      allowedApproverRoles: [`team:${TEAM_ONE}:admin`, `team:${TEAM_TWO}:admin`],
      requiredApproverRoles: [`team:${TEAM_ONE}:admin`, `team:${TEAM_TWO}:admin`],
      proposerPrincipalId: "proposer",
      preview: "delete agent",
      riskSummary: "destructive",
      expiresAt: new Date("2026-09-05T13:00:00.000Z"),
      createdAt: now,
    });
    for (const [principalId, role] of [
      ["admin-one", `team:${TEAM_ONE}:admin`],
      ["admin-two", `team:${TEAM_TWO}:admin`],
    ] as const) {
      await repo.appendDecision("business-1", "123e4567-e89b-42d3-a456-426614174000", {
        approverPrincipalId: principalId,
        approverRoles: [role],
        satisfiedApproverRole: role,
        outcome: "approved",
        decidedAt: now,
      });
    }

    await expect(
      repo.consume("business-1", "123e4567-e89b-42d3-a456-426614174000", binding, now)
    ).resolves.toMatchObject({ consumedAt: now });
    await expect(
      repo.consume("business-1", "123e4567-e89b-42d3-a456-426614174000", binding, now)
    ).rejects.toMatchObject({ code: "already_used" });
  });

  it("rechecks exact Team-admin authority when the Approval is consumed", async () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    const approvalId = "123e4567-e89b-42d3-a456-426614174001";
    const role = `team:${TEAM_ONE}:admin`;
    const binding = {
      intentDigest: "intent-live",
      evidenceDigest: "evidence-live",
      guardrailRevision: "asset-ownership-v1",
    };
    await repo.create({
      approvalId,
      businessId: "business-1",
      binding,
      risk: "high",
      allowedApproverRoles: [role],
      requiredApproverRoles: [role],
      proposerPrincipalId: "proposer",
      preview: "archive file",
      riskSummary: "destructive",
      expiresAt: new Date("2026-09-05T13:00:00.000Z"),
      createdAt: now,
    });
    await repo.appendDecision("business-1", approvalId, {
      approverPrincipalId: "admin-one",
      approverRoles: [role],
      satisfiedApproverRole: role,
      outcome: "approved",
      decidedAt: now,
    });
    await database.query(
      `UPDATE team_memberships
          SET level = 'member', revision = revision + 1, updated_at = now()
        WHERE team_id = $1 AND principal_id = 'admin-one'`,
      [TEAM_ONE]
    );

    await expect(repo.consume("business-1", approvalId, binding, now)).rejects.toMatchObject({
      code: "insufficient_approvals",
    });
    expect((await repo.get("business-1", approvalId))?.consumedAt).toBeUndefined();
  });

  it("loads a bounded Approval set in caller order", async () => {
    const found = await repo.getMany("business-1", [
      "123e4567-e89b-42d3-a456-426614174001",
      "missing",
      "123e4567-e89b-42d3-a456-426614174000",
    ]);

    expect(found.map((approval) => approval.approvalId)).toEqual([
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174000",
    ]);
    expect(found[0]?.decisions).toHaveLength(1);
    expect(found[1]?.decisions).toHaveLength(2);
  });

  it("loads only open candidate Approvals for requested Teams", async () => {
    const at = new Date("2026-09-05T12:30:00.000Z");
    for (const [approvalId, teamId, expiresAt] of [
      ["123e4567-e89b-42d3-a456-426614174010", TEAM_ONE, "2026-09-05T13:00:00.000Z"],
      ["123e4567-e89b-42d3-a456-426614174011", TEAM_TWO, "2026-09-05T13:00:00.000Z"],
      ["123e4567-e89b-42d3-a456-426614174012", TEAM_ONE, "2026-09-05T12:00:00.000Z"],
      ["123e4567-e89b-42d3-a456-426614174013", TEAM_ONE, "2026-09-05T13:00:00.000Z"],
    ] as const) {
      await repo.create({
        approvalId,
        businessId: "business-1",
        binding: {
          intentDigest: `intent-${approvalId}`,
          evidenceDigest: `evidence-${approvalId}`,
          guardrailRevision: "asset-ownership-v1",
        },
        risk: "high",
        allowedApproverRoles: [`team:${teamId}:admin`],
        requiredApproverRoles: [`team:${teamId}:admin`],
        proposerPrincipalId: "proposer",
        preview: "change asset",
        riskSummary: "ownership change",
        expiresAt: new Date(expiresAt),
        createdAt: new Date("2026-09-05T12:00:00.000Z"),
      });
    }
    await repo.revoke(
      "business-1",
      "123e4567-e89b-42d3-a456-426614174013",
      new Date("2026-09-05T12:15:00.000Z")
    );

    const records = await repo.getOpenMany(
      "business-1",
      [
        "123e4567-e89b-42d3-a456-426614174011",
        "123e4567-e89b-42d3-a456-426614174012",
        "123e4567-e89b-42d3-a456-426614174013",
        "123e4567-e89b-42d3-a456-426614174010",
      ],
      { at, requiredTeamIds: [TEAM_ONE] }
    );

    expect(records.map((record) => record.approvalId)).toEqual([
      "123e4567-e89b-42d3-a456-426614174010",
    ]);
  });
});
