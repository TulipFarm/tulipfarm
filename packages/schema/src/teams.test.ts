import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ajv } from "./ajv";
import { RoleSchema } from "./definitions/role";
import {
  DeprecatedGroupCreateRequestSchema,
  DeprecatedGroupResponseSchema,
  GROUP_COMPATIBILITY_DEPRECATION,
  ROLE_ASSIGNMENT_TARGET_KINDS,
  TeamAccessExplanationSchema,
  TeamAssetOwnershipSchema,
  TeamBusinessAssetOwnershipSchema,
  TeamCreateRequestSchema,
  TeamMembershipSchema,
  TeamSchema,
} from "./teams";

const TEAM_ID = "123e4567-e89b-42d3-a456-426614174000";
const PARENT_ID = "123e4567-e89b-42d3-a456-426614174001";
const NOW = "2026-09-05T09:34:18.595Z";

const team = {
  id: TEAM_ID,
  businessId: "business-1",
  slug: "customer-success",
  displayName: "Customer Success",
  description: "Helps customers succeed.",
  labels: ["customer-facing", "operations"],
  status: "active",
  parentTeamId: PARENT_ID,
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

describe("Team contracts", () => {
  it("accepts canonical Team identity and lifecycle fields", () => {
    expect(ajv.compile(TeamSchema)(team)).toBe(true);
  });

  it("rejects a mutable-looking or invalid Team slug", () => {
    const validate = ajv.compile(TeamSchema);
    expect(validate({ ...team, slug: "Customer Success" })).toBe(false);
    expect(validate({ ...team, id: "team-1" })).toBe(false);
  });

  it("requires a parent and at least one initial human admin on creation", () => {
    const validate = ajv.compile(TeamCreateRequestSchema);
    expect(
      validate({
        slug: team.slug,
        displayName: team.displayName,
        parentTeamId: PARENT_ID,
        initialAdminUserIds: ["user-1"],
      })
    ).toBe(true);
    expect(
      validate({
        slug: team.slug,
        displayName: team.displayName,
        parentTeamId: PARENT_ID,
        initialAdminUserIds: [],
      })
    ).toBe(false);
  });

  it("bounds Team labels", () => {
    const validate = ajv.compile(TeamCreateRequestSchema);
    expect(
      validate({
        slug: team.slug,
        displayName: team.displayName,
        labels: ["engineering", "infrastructure"],
        parentTeamId: PARENT_ID,
        initialAdminUserIds: ["user-1"],
      })
    ).toBe(true);
    expect(
      validate({
        slug: team.slug,
        displayName: team.displayName,
        labels: ["x".repeat(41)],
        parentTeamId: PARENT_ID,
        initialAdminUserIds: ["user-1"],
      })
    ).toBe(false);
  });

  it("restricts Team membership kinds and levels", () => {
    const validate = ajv.compile(TeamMembershipSchema);
    const membership = {
      teamId: TEAM_ID,
      principalId: "agent-1",
      principalKind: "agent",
      level: "member",
      expiresAt: null,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(validate(membership)).toBe(true);
    expect(validate({ ...membership, principalKind: "routine" })).toBe(false);
    expect(validate({ ...membership, level: "owner" })).toBe(false);
    expect(validate({ ...membership, level: "admin" })).toBe(false);
    expect(validate({ ...membership, principalKind: "user", level: "admin" })).toBe(true);
  });

  it("supports Team Role targets", () => {
    expect(ROLE_ASSIGNMENT_TARGET_KINDS).toContain("team");
    expect(
      ajv.compile(RoleSchema)({
        apiVersion: "tulipfarm.ai/v1",
        kind: "Role",
        metadata: {
          id: TEAM_ID,
          slug: "team-operator",
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "draft",
        },
        spec: {
          principalTypes: ["team"],
          grants: [],
        },
      })
    ).toBe(true);
  });

  it("represents Team and personal ownership without treating personal owners as Teams", () => {
    const validate = ajv.compile(TeamAssetOwnershipSchema);
    expect(
      validate({
        assetType: "file",
        assetId: "file-1",
        owners: [
          { kind: "team", teamId: TEAM_ID },
          { kind: "principal", principalId: "user-1", principalKind: "user" },
        ],
        revision: 1,
      })
    ).toBe(true);
    expect(
      validate({
        assetType: "routine",
        assetId: "routine-1",
        owners: [{ kind: "principal", principalId: "agent-1", principalKind: "agent" }],
        revision: 1,
      })
    ).toBe(false);
  });

  it("requires at least one Team owner for business asset metadata", () => {
    const validate = ajv.compile(TeamBusinessAssetOwnershipSchema);
    expect(
      validate({
        owners: [{ teamId: TEAM_ID }, { teamId: PARENT_ID }],
        shares: [{ teamId: PARENT_ID, access: "use" }],
      })
    ).toBe(true);
    expect(validate({ owners: [] })).toBe(false);
    expect(validate({ owners: [{ principalId: "user-1" }] })).toBe(false);
  });

  describe("Team terminology", () => {
    it("makes Team canonical and confines group to compatibility and migration", () => {
      const glossary = readFileSync(
        new URL("../../../metadata/terminologies.md", import.meta.url),
        "utf8"
      );
      expect(glossary).toContain(
        "| A business organizational and inherited-authority unit | **Team** | `Team` |"
      );
      expect(glossary).toContain(
        "`group` is permitted only at the deprecated one-release API compatibility boundary"
      );
    });
  });

  it("carries ordered, structured allow and deny evidence", () => {
    const validate = ajv.compile(TeamAccessExplanationSchema);
    expect(
      validate({
        allowed: false,
        reason: "explicit_deny",
        action: "file.read",
        resource: "file:file-1",
        evidence: [
          {
            kind: "inherited_membership",
            effect: "informational",
            sourceTeamId: TEAM_ID,
            pathTeamIds: [TEAM_ID, PARENT_ID],
          },
          {
            kind: "explicit_deny",
            effect: "deny",
            sourceTeamId: PARENT_ID,
            grantId: "grant-1",
          },
        ],
      })
    ).toBe(true);
  });
});

describe("deprecated group compatibility", () => {
  it("reuses Team request validation instead of defining another model", () => {
    expect(DeprecatedGroupCreateRequestSchema).toBe(TeamCreateRequestSchema);
  });

  it("returns the Team model with explicit one-release deprecation metadata", () => {
    const validate = ajv.compile(DeprecatedGroupResponseSchema);
    expect(
      validate({
        team,
        deprecation: GROUP_COMPATIBILITY_DEPRECATION,
      })
    ).toBe(true);
  });
});
