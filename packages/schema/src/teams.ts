import { type Static, Type } from "@sinclair/typebox";
import { PRINCIPAL_KINDS, type PrincipalKind } from "./principals";

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const TEAM_SLUG_PATTERN = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";

export const TEAM_LIFECYCLE_STATUSES = ["active", "archived"] as const;
export const TEAM_MEMBERSHIP_LEVELS = ["member", "admin"] as const;
export const TEAM_MEMBER_PRINCIPAL_KINDS = [
  "user",
  "agent",
  "service",
] as const satisfies readonly PrincipalKind[];
export const ROLE_ASSIGNMENT_TARGET_KINDS = [...PRINCIPAL_KINDS, "team"] as const;
export const TEAM_ASSET_TYPES = ["agent", "skill", "routine", "file", "knowledge"] as const;
export const TEAM_ASSET_ACCESS_LEVELS = ["view", "use", "edit"] as const;
export const TEAM_ACCESS_EVIDENCE_KINDS = [
  "direct_membership",
  "inherited_membership",
  "team_ancestry",
  "role",
  "grant",
  "explicit_deny",
  "expiry",
  "authority_layer",
] as const;

function stringEnum<const Values extends readonly string[]>(values: Values) {
  return Type.Unsafe<Values[number]>({ type: "string", enum: [...values] });
}

export const TeamIdSchema = Type.String({
  pattern: UUID_PATTERN,
  description: "Permanent Team UUID.",
});

export const TeamSlugSchema = Type.String({
  pattern: TEAM_SLUG_PATTERN,
  maxLength: 128,
  description:
    "Permanent lowercase kebab-case Team slug, unique within a business and never reusable.",
});

export const TeamLabelsSchema = Type.Array(Type.String({ minLength: 1, maxLength: 40 }), {
  maxItems: 12,
  uniqueItems: true,
  description: "Short labels used to group and filter Teams.",
});

export const TeamSchema = Type.Object(
  {
    id: TeamIdSchema,
    businessId: Type.String({ minLength: 1 }),
    slug: TeamSlugSchema,
    displayName: Type.String({
      minLength: 1,
      maxLength: 256,
      description: "Editable Team name, unique among siblings.",
    }),
    description: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
    labels: Type.Optional(TeamLabelsSchema),
    status: stringEnum(TEAM_LIFECYCLE_STATUSES),
    parentTeamId: Type.Union([TeamIdSchema, Type.Null()], {
      description: "Parent Team UUID; null only for the protected Everyone root.",
    }),
    revision: Type.Integer({ minimum: 1 }),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
    archivedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  },
  { additionalProperties: false }
);

export const TeamCreateRequestSchema = Type.Object(
  {
    slug: TeamSlugSchema,
    displayName: Type.String({
      minLength: 1,
      maxLength: 256,
      description: "Editable Team name, unique among siblings.",
    }),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    labels: Type.Optional(TeamLabelsSchema),
    parentTeamId: TeamIdSchema,
    initialAdminUserIds: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

export const TeamUpdateRequestSchema = Type.Object(
  {
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
    labels: Type.Optional(TeamLabelsSchema),
    revision: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false, minProperties: 2 }
);

export const TeamMoveRequestSchema = Type.Object(
  {
    parentTeamId: TeamIdSchema,
    revision: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);

const TeamMembershipBaseProperties = {
  teamId: TeamIdSchema,
  principalId: Type.String({ minLength: 1 }),
  expiresAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  revision: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
};

export const TeamMembershipSchema = Type.Union([
  Type.Object(
    {
      ...TeamMembershipBaseProperties,
      principalKind: Type.Literal("user"),
      level: stringEnum(TEAM_MEMBERSHIP_LEVELS),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...TeamMembershipBaseProperties,
      principalKind: stringEnum(["agent", "service"] as const),
      level: Type.Literal("member"),
    },
    { additionalProperties: false }
  ),
]);

export const TeamMembershipEvidenceSchema = Type.Object(
  {
    membership: stringEnum(["direct", "inherited"] as const),
    teamId: TeamIdSchema,
    sourceTeamId: TeamIdSchema,
    pathTeamIds: Type.Array(TeamIdSchema, { minItems: 1, uniqueItems: true }),
    level: stringEnum(TEAM_MEMBERSHIP_LEVELS),
    expiresAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  },
  { additionalProperties: false }
);

export const TeamHierarchySchema = Type.Object(
  {
    teamId: TeamIdSchema,
    parentTeamId: Type.Union([TeamIdSchema, Type.Null()]),
    ancestorTeamIds: Type.Array(TeamIdSchema, { maxItems: 9, uniqueItems: true }),
    depth: Type.Integer({ minimum: 1, maximum: 10 }),
  },
  { additionalProperties: false }
);

export const TeamDelegationGrantScopeSchema = Type.Object(
  {
    actions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
    resourceTypes: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

export const TeamDelegationPolicySchema = Type.Object(
  {
    teamId: TeamIdSchema,
    allowedRoleIds: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    allowedGrantScopes: Type.Array(TeamDelegationGrantScopeSchema),
    revision: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);

export const TeamAssetOwnerSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("team"),
      teamId: TeamIdSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("principal"),
      principalId: Type.String({ minLength: 1 }),
      principalKind: Type.Literal("user"),
    },
    { additionalProperties: false }
  ),
]);

export const TeamAssetOwnershipSchema = Type.Object(
  {
    assetType: stringEnum(TEAM_ASSET_TYPES),
    assetId: Type.String({ minLength: 1 }),
    owners: Type.Array(TeamAssetOwnerSchema, { minItems: 1, uniqueItems: true }),
    revision: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);

export const TeamAssetShareSchema = Type.Object(
  {
    assetType: stringEnum(TEAM_ASSET_TYPES),
    assetId: Type.String({ minLength: 1 }),
    teamId: TeamIdSchema,
    access: stringEnum(TEAM_ASSET_ACCESS_LEVELS),
    revision: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);

export const TeamBusinessAssetOwnershipSchema = Type.Object(
  {
    owners: Type.Array(Type.Object({ teamId: TeamIdSchema }, { additionalProperties: false }), {
      minItems: 1,
    }),
    shares: Type.Optional(
      Type.Array(
        Type.Object(
          {
            teamId: TeamIdSchema,
            access: stringEnum(TEAM_ASSET_ACCESS_LEVELS),
          },
          { additionalProperties: false }
        )
      )
    ),
  },
  { additionalProperties: false }
);

export const TeamAccessEvidenceSchema = Type.Object(
  {
    kind: stringEnum(TEAM_ACCESS_EVIDENCE_KINDS),
    effect: stringEnum(["allow", "deny", "informational"] as const),
    sourceTeamId: Type.Optional(TeamIdSchema),
    sourcePrincipalId: Type.Optional(Type.String({ minLength: 1 })),
    roleId: Type.Optional(Type.String({ minLength: 1 })),
    grantId: Type.Optional(Type.String({ minLength: 1 })),
    authorityLayer: Type.Optional(Type.String({ minLength: 1 })),
    pathTeamIds: Type.Optional(Type.Array(TeamIdSchema, { minItems: 1, uniqueItems: true })),
    expiresAt: Type.Optional(Type.String({ format: "date-time" })),
  },
  { additionalProperties: false }
);

export const TeamAccessExplanationSchema = Type.Object(
  {
    allowed: Type.Boolean(),
    reason: Type.String({ minLength: 1 }),
    action: Type.String({ minLength: 1 }),
    resource: Type.String({ minLength: 1 }),
    evidence: Type.Array(TeamAccessEvidenceSchema),
  },
  { additionalProperties: false }
);

export const GROUP_COMPATIBILITY_DEPRECATION = {
  deprecated: true,
  replacement: "Team",
  replacementPath: "/api/v1/teams",
  removal: "one_release_after_team_api_launch",
} as const;

export const GroupCompatibilityDeprecationSchema = Type.Object(
  {
    deprecated: Type.Literal(true),
    replacement: Type.Literal("Team"),
    replacementPath: Type.Literal("/api/v1/teams"),
    removal: Type.Literal("one_release_after_team_api_launch"),
  },
  { additionalProperties: false }
);

/** @deprecated Use TeamCreateRequestSchema. Removed one release after the Team API launches. */
export const DeprecatedGroupCreateRequestSchema = TeamCreateRequestSchema;
/** @deprecated Use TeamUpdateRequestSchema. Removed one release after the Team API launches. */
export const DeprecatedGroupUpdateRequestSchema = TeamUpdateRequestSchema;
/** @deprecated Use TeamSchema. Removed one release after the Team API launches. */
export const DeprecatedGroupSchema = TeamSchema;

export const DeprecatedGroupResponseSchema = Type.Object(
  {
    team: TeamSchema,
    deprecation: GroupCompatibilityDeprecationSchema,
  },
  { additionalProperties: false }
);

export type TeamId = Static<typeof TeamIdSchema>;
export type TeamSlug = Static<typeof TeamSlugSchema>;
export type Team = Static<typeof TeamSchema>;
export type TeamCreateRequest = Static<typeof TeamCreateRequestSchema>;
export type TeamUpdateRequest = Static<typeof TeamUpdateRequestSchema>;
export type TeamMoveRequest = Static<typeof TeamMoveRequestSchema>;
export type TeamMembership = Static<typeof TeamMembershipSchema>;
export type TeamMembershipEvidence = Static<typeof TeamMembershipEvidenceSchema>;
export type TeamHierarchy = Static<typeof TeamHierarchySchema>;
export type TeamDelegationGrantScope = Static<typeof TeamDelegationGrantScopeSchema>;
export type TeamDelegationPolicy = Static<typeof TeamDelegationPolicySchema>;
export type TeamAssetOwner = Static<typeof TeamAssetOwnerSchema>;
export type TeamAssetOwnership = Static<typeof TeamAssetOwnershipSchema>;
export type TeamAssetShare = Static<typeof TeamAssetShareSchema>;
export type TeamBusinessAssetOwnership = Static<typeof TeamBusinessAssetOwnershipSchema>;
export type TeamAccessEvidence = Static<typeof TeamAccessEvidenceSchema>;
export type TeamAccessExplanation = Static<typeof TeamAccessExplanationSchema>;
export type TeamLifecycleStatus = (typeof TEAM_LIFECYCLE_STATUSES)[number];
export type TeamMembershipLevel = (typeof TEAM_MEMBERSHIP_LEVELS)[number];
export type TeamMemberPrincipalKind = (typeof TEAM_MEMBER_PRINCIPAL_KINDS)[number];
export type RoleAssignmentTargetKind = (typeof ROLE_ASSIGNMENT_TARGET_KINDS)[number];
export type TeamAssetType = (typeof TEAM_ASSET_TYPES)[number];
export type TeamAssetAccessLevel = (typeof TEAM_ASSET_ACCESS_LEVELS)[number];
export type TeamAccessEvidenceKind = (typeof TEAM_ACCESS_EVIDENCE_KINDS)[number];
/** @deprecated Use TeamCreateRequest. Removed one release after the Team API launches. */
export type DeprecatedGroupCreateRequest = TeamCreateRequest;
/** @deprecated Use TeamUpdateRequest. Removed one release after the Team API launches. */
export type DeprecatedGroupUpdateRequest = TeamUpdateRequest;
/** @deprecated Use Team. Removed one release after the Team API launches. */
export type DeprecatedGroup = Team;
export type DeprecatedGroupResponse = Static<typeof DeprecatedGroupResponseSchema>;
