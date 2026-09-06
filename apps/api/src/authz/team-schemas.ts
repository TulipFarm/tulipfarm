import {
  GroupCompatibilityDeprecationSchema,
  TeamAccessExplanationSchema,
  TeamCreateRequestSchema,
  TeamDelegationGrantScopeSchema,
  TeamHierarchySchema,
  TeamMembershipSchema,
  TeamSchema,
  TeamUpdateRequestSchema,
} from "@tulipfarm/schema";

export const TEAM_SECURITY = [{ sessionCookie: [] }, { bearerToken: [] }] as const;
export const TeamIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["teamId"],
  properties: { teamId: { type: "string", format: "uuid" } },
} as const;
export const TeamMemberParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["teamId", "principalId"],
  properties: {
    teamId: { type: "string", format: "uuid" },
    principalId: { type: "string", minLength: 1 },
  },
} as const;
export const TeamRoleParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["teamId", "roleId"],
  properties: {
    teamId: { type: "string", format: "uuid" },
    roleId: { type: "string", minLength: 1 },
  },
} as const;
export const TeamGrantParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["teamId", "grantId"],
  properties: {
    teamId: { type: "string", format: "uuid" },
    grantId: { type: "string", format: "uuid" },
  },
} as const;
export const TeamLeaveParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["teamId", "requestId"],
  properties: {
    teamId: { type: "string", format: "uuid" },
    requestId: { type: "string", format: "uuid" },
  },
} as const;
const TeamDirectoryMemberSchema = {
  type: "object",
  additionalProperties: false,
  required: ["principalId", "name", "level"],
  properties: {
    principalId: { type: "string" },
    name: { type: "string" },
    level: { type: "string", enum: ["member", "admin"] },
  },
} as const;
const TeamDirectoryEntrySchema = {
  ...TeamSchema,
  properties: {
    ...TeamSchema.properties,
    members: { type: "array", items: TeamDirectoryMemberSchema },
  },
  required: [...TeamSchema.required, "members"],
} as const;
export const TeamListSchema = {
  type: "object",
  additionalProperties: false,
  required: ["teams"],
  properties: { teams: { type: "array", items: TeamDirectoryEntrySchema } },
} as const;
export const TeamHierarchyResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["teams"],
  properties: { teams: { type: "array", items: TeamHierarchySchema } },
} as const;
const ResolvedMemberSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "membership",
    "sourceTeamId",
    "pathTeamIds",
    "principalId",
    "principalKind",
    "level",
    "expiresAt",
    "removable",
    "revision",
  ],
  properties: {
    membership: { type: "string", enum: ["direct", "inherited"] },
    sourceTeamId: { type: "string", format: "uuid" },
    pathTeamIds: { type: "array", items: { type: "string", format: "uuid" } },
    principalId: { type: "string" },
    principalKind: { type: "string", enum: ["user", "agent", "service"] },
    level: { type: "string", enum: ["member", "admin"] },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    removable: { type: "boolean" },
    revision: { type: "integer", minimum: 1 },
  },
} as const;
export const TeamMembersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["direct", "inherited"],
  properties: {
    direct: { type: "array", items: ResolvedMemberSchema },
    inherited: { type: "array", items: ResolvedMemberSchema },
  },
} as const;
export const TeamMemberBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["principalId", "level"],
  properties: {
    principalId: { type: "string", minLength: 1 },
    level: { type: "string", enum: ["member", "admin"] },
    expiresAt: { type: "string", format: "date-time" },
  },
} as const;
export const TeamMemberUpdateBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["level", "revision"],
  properties: {
    level: { type: "string", enum: ["member", "admin"] },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    revision: { type: "integer", minimum: 1 },
  },
} as const;
export const RevisionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["revision"],
  properties: { revision: { type: "integer", minimum: 1 } },
} as const;
export const AdminRecoveryBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["principalId", "revision"],
  properties: {
    principalId: { type: "string", minLength: 1 },
    revision: { type: "integer", minimum: 1 },
  },
} as const;
export const BulkMemberAddBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["members"],
  properties: {
    members: { type: "array", minItems: 1, maxItems: 100, items: TeamMemberBodySchema },
  },
} as const;
export const BulkMemberRemoveBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["members"],
  properties: {
    members: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["principalId", "revision"],
        properties: {
          principalId: { type: "string", minLength: 1 },
          revision: { type: "integer", minimum: 1 },
        },
      },
    },
  },
} as const;
export const BulkResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["principalId", "ok"],
        properties: {
          principalId: { type: "string" },
          ok: { type: "boolean" },
          membership: TeamMembershipSchema,
          error: { type: "string" },
        },
      },
    },
  },
} as const;
export const LeaveRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "teamId",
    "principalId",
    "status",
    "revision",
    "requestedAt",
    "decidedAt",
    "decidedByPrincipalId",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    teamId: { type: "string", format: "uuid" },
    principalId: { type: "string" },
    status: { type: "string", enum: ["pending", "approved", "rejected"] },
    revision: { type: "integer", minimum: 1 },
    requestedAt: { type: "string", format: "date-time" },
    decidedAt: { type: ["string", "null"], format: "date-time" },
    decidedByPrincipalId: { type: ["string", "null"] },
  },
} as const;
export const LeaveRequestListSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requests"],
  properties: { requests: { type: "array", items: LeaveRequestSchema } },
} as const;
export const LeaveDecisionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "revision"],
  properties: {
    decision: { type: "string", enum: ["approved", "rejected"] },
    revision: { type: "integer", minimum: 1 },
  },
} as const;
const TeamRoleViewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source", "sourceTeamId", "pathTeamIds", "roleId", "expiresAt", "assignedAt"],
  properties: {
    source: { type: "string", enum: ["direct", "inherited"] },
    sourceTeamId: { type: "string", format: "uuid" },
    pathTeamIds: { type: "array", items: { type: "string", format: "uuid" } },
    roleId: { type: "string" },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    assignedAt: { type: "string", format: "date-time" },
  },
} as const;
const TeamGrantViewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "source",
    "sourceTeamId",
    "pathTeamIds",
    "id",
    "action",
    "resourceType",
    "effect",
    "domain",
    "recordSelector",
    "fieldSelector",
    "dataClass",
    "destination",
    "conditions",
    "expiresAt",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    source: { type: "string", enum: ["direct", "inherited"] },
    sourceTeamId: { type: "string", format: "uuid" },
    pathTeamIds: { type: "array", items: { type: "string", format: "uuid" } },
    id: { type: "string", format: "uuid" },
    action: { type: "string" },
    resourceType: { type: "string" },
    effect: { type: "string", enum: ["allow", "deny"] },
    domain: { type: ["string", "null"] },
    recordSelector: { type: ["string", "null"] },
    fieldSelector: { type: ["array", "null"], items: { type: "string" } },
    dataClass: { type: ["string", "null"] },
    destination: { type: ["string", "null"] },
    conditions: { type: ["object", "null"], additionalProperties: { type: "string" } },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;
export const TeamAuthoritySchema = {
  type: "object",
  additionalProperties: false,
  required: ["directRoles", "inheritedRoles", "directGrants", "inheritedGrants"],
  properties: {
    directRoles: { type: "array", items: TeamRoleViewSchema },
    inheritedRoles: { type: "array", items: TeamRoleViewSchema },
    directGrants: { type: "array", items: TeamGrantViewSchema },
    inheritedGrants: { type: "array", items: TeamGrantViewSchema },
  },
} as const;
export const TeamRoleBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["roleId"],
  properties: {
    roleId: { type: "string", minLength: 1 },
    expiresAt: { type: "string", format: "date-time" },
  },
} as const;
export const TeamGrantBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "resourceType", "effect"],
  properties: {
    action: { type: "string", minLength: 1 },
    resourceType: { type: "string", minLength: 1 },
    effect: { type: "string", enum: ["allow", "deny"] },
    domain: { type: "string" },
    recordSelector: { type: "string" },
    fieldSelector: { type: "array", items: { type: "string" } },
    dataClass: { type: "string" },
    destination: { type: "string" },
    conditions: { type: "object", additionalProperties: { type: "string" } },
    expiresAt: { type: "string", format: "date-time" },
  },
} as const;
export const CreatedGrantSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;
export const DelegationPolicySchema = {
  type: "object",
  additionalProperties: false,
  required: ["teamId", "allowedRoleIds", "allowedGrantScopes", "revision", "updatedAt"],
  properties: {
    teamId: { type: "string", format: "uuid" },
    allowedRoleIds: { type: "array", items: { type: "string" } },
    allowedGrantScopes: { type: "array", items: TeamDelegationGrantScopeSchema },
    revision: { type: "integer", minimum: 0 },
    updatedAt: { type: ["string", "null"], format: "date-time" },
  },
} as const;
export const DelegationPolicyBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["allowedRoleIds", "allowedGrantScopes", "revision"],
  properties: {
    allowedRoleIds: { type: "array", uniqueItems: true, items: { type: "string" } },
    allowedGrantScopes: { type: "array", items: TeamDelegationGrantScopeSchema },
    revision: { type: "integer", minimum: 0 },
  },
} as const;
export const MovePreviewBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["parentTeamId", "revision"],
  properties: {
    parentTeamId: { type: "string", format: "uuid" },
    revision: { type: "integer", minimum: 1 },
  },
} as const;
export const MoveConfirmBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["parentTeamId", "previewToken"],
  properties: {
    parentTeamId: { type: "string", format: "uuid" },
    previewToken: { type: "string", minLength: 32, maxLength: 128 },
  },
} as const;
const MoveAuthoritySourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sourceTeamId", "id"],
  properties: {
    sourceTeamId: { type: "string", format: "uuid" },
    id: { type: "string", minLength: 1 },
  },
} as const;
const MoveAuthorityImpactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["direct", "currentInherited", "proposedInherited", "gained", "lost"],
  properties: {
    direct: { type: "array", items: MoveAuthoritySourceSchema },
    currentInherited: { type: "array", items: MoveAuthoritySourceSchema },
    proposedInherited: { type: "array", items: MoveAuthoritySourceSchema },
    gained: { type: "array", items: MoveAuthoritySourceSchema },
    lost: { type: "array", items: MoveAuthoritySourceSchema },
  },
} as const;
const MoveAssetSourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assetType", "assetId", "sourceTeamId", "relation", "access", "revision"],
  properties: {
    assetType: {
      type: "string",
      enum: ["agent", "skill", "routine", "file", "knowledge"],
    },
    assetId: { type: "string", minLength: 1 },
    sourceTeamId: { type: "string", format: "uuid" },
    relation: { type: "string", enum: ["owner", "share"] },
    access: { type: "string", enum: ["view", "use", "edit"] },
    revision: { type: "integer", minimum: 1 },
  },
} as const;
export const MovePreviewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "teamId",
    "proposedParentTeamId",
    "teamRevision",
    "currentAncestorTeamIds",
    "proposedAncestorTeamIds",
    "gainedAncestorTeamIds",
    "lostAncestorTeamIds",
    "descendantTeamIds",
    "identities",
    "roles",
    "grants",
    "assets",
    "accessChanges",
    "evidenceDigest",
    "previewToken",
    "previewExpiresAt",
  ],
  properties: {
    teamId: { type: "string", format: "uuid" },
    proposedParentTeamId: { type: "string", format: "uuid" },
    teamRevision: { type: "integer", minimum: 1 },
    currentAncestorTeamIds: { type: "array", items: { type: "string", format: "uuid" } },
    proposedAncestorTeamIds: { type: "array", items: { type: "string", format: "uuid" } },
    gainedAncestorTeamIds: { type: "array", items: { type: "string", format: "uuid" } },
    lostAncestorTeamIds: { type: "array", items: { type: "string", format: "uuid" } },
    descendantTeamIds: { type: "array", items: { type: "string", format: "uuid" } },
    identities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["principalId", "principalKind", "directTeamIds"],
        properties: {
          principalId: { type: "string", minLength: 1 },
          principalKind: { type: "string", enum: ["user", "agent", "service"] },
          directTeamIds: { type: "array", items: { type: "string", format: "uuid" } },
        },
      },
    },
    roles: MoveAuthorityImpactSchema,
    grants: MoveAuthorityImpactSchema,
    assets: {
      type: "object",
      additionalProperties: false,
      required: [
        "owned",
        "directlyShared",
        "currentInherited",
        "proposedInherited",
        "gained",
        "lost",
      ],
      properties: {
        owned: { type: "array", items: MoveAssetSourceSchema },
        directlyShared: { type: "array", items: MoveAssetSourceSchema },
        currentInherited: { type: "array", items: MoveAssetSourceSchema },
        proposedInherited: { type: "array", items: MoveAssetSourceSchema },
        gained: { type: "array", items: MoveAssetSourceSchema },
        lost: { type: "array", items: MoveAssetSourceSchema },
      },
    },
    accessChanges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "principalId",
          "gainedRoleIds",
          "lostRoleIds",
          "gainedGrantIds",
          "lostGrantIds",
          "gainedAssetIds",
          "lostAssetIds",
        ],
        properties: {
          principalId: { type: "string", minLength: 1 },
          gainedRoleIds: { type: "array", items: { type: "string" } },
          lostRoleIds: { type: "array", items: { type: "string" } },
          gainedGrantIds: { type: "array", items: { type: "string" } },
          lostGrantIds: { type: "array", items: { type: "string" } },
          gainedAssetIds: { type: "array", items: { type: "string" } },
          lostAssetIds: { type: "array", items: { type: "string" } },
        },
      },
    },
    evidenceDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    previewToken: { type: "string", minLength: 32 },
    previewExpiresAt: { type: "string", format: "date-time" },
  },
} as const;
export const TeamActivityQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    action: { type: "string" },
  },
} as const;
export const TeamActivitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "action",
          "actorId",
          "targetId",
          "summary",
          "target",
          "reason",
          "outcome",
          "emergency",
          "metadata",
          "createdAt",
        ],
        properties: {
          id: { type: "string" },
          action: { type: "string" },
          actorId: { type: ["string", "null"] },
          targetId: { type: ["string", "null"] },
          summary: { type: "string" },
          target: { type: "string" },
          reason: { type: ["string", "null"] },
          outcome: { type: "string", enum: ["succeeded", "failed"] },
          emergency: { type: "boolean" },
          metadata: { type: "object", additionalProperties: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
    },
    nextCursor: { type: ["string", "null"] },
  },
} as const;
export const AccessExplanationBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["principalId", "action", "resourceType"],
  properties: {
    principalId: { type: "string", minLength: 1 },
    action: { type: "string", minLength: 1 },
    resourceType: { type: "string", minLength: 1 },
    agentId: { type: "string" },
    domain: { type: "string" },
    recordId: { type: "string" },
    field: { type: "string" },
    dataClass: { type: "string" },
    destination: { type: "string" },
    conditions: { type: "object", additionalProperties: { type: "string" } },
  },
} as const;
export const EmptyResponseSchema = { type: "null" } as const;
export const LegacyGroupParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["groupId"],
  properties: { groupId: { type: "string", minLength: 1 } },
} as const;
export const LegacyGroupMemberParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["groupId", "principalId"],
  properties: {
    groupId: { type: "string", minLength: 1 },
    principalId: { type: "string", minLength: 1 },
  },
} as const;
export const LegacyGroupRoleParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["groupId", "roleId"],
  properties: {
    groupId: { type: "string", minLength: 1 },
    roleId: { type: "string", minLength: 1 },
  },
} as const;
export const LegacyGroupCreateBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1 },
    displayName: { type: "string" },
    description: { type: "string" },
    parentTeamId: { type: "string", format: "uuid" },
    initialAdminUserIds: { type: "array", items: { type: "string" } },
    expiresAt: { type: "string", format: "date-time" },
  },
} as const;
export const LegacyGroupMemberBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["principalId"],
  properties: {
    principalId: { type: "string", minLength: 1 },
    level: { type: "string", enum: ["member", "admin"], default: "member" },
    expiresAt: { type: "string", format: "date-time" },
  },
} as const;
export const LegacyGroupResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["team", "deprecation"],
  properties: { team: TeamSchema, deprecation: GroupCompatibilityDeprecationSchema },
} as const;
export const LegacyGroupListSchema = {
  type: "object",
  additionalProperties: false,
  required: ["teams", "deprecation"],
  properties: {
    teams: { type: "array", items: TeamSchema },
    deprecation: GroupCompatibilityDeprecationSchema,
  },
} as const;
export const DeprecatedOkSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "deprecation"],
  properties: {
    status: { type: "string", const: "ok" },
    deprecation: GroupCompatibilityDeprecationSchema,
  },
} as const;
export const DeprecatedMembershipSchema = {
  type: "object",
  additionalProperties: false,
  required: ["membership", "deprecation"],
  properties: {
    membership: TeamMembershipSchema,
    deprecation: GroupCompatibilityDeprecationSchema,
  },
} as const;

export {
  TeamAccessExplanationSchema,
  TeamCreateRequestSchema,
  TeamMembershipSchema,
  TeamSchema,
  TeamUpdateRequestSchema,
};
