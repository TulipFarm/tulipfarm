/**
 * Shared JSON Schema objects for the admin authorization routes. Kept here so the response shapes
 * the OpenAPI spec advertises are defined once and reused across the read and explain endpoints.
 */

export const AUTHZ_SECURITY = [{ sessionCookie: [] }, { bearerToken: [] }] as const;

/** Non-human principal kinds; `user` rows are maintained by the user store. */
export const REGISTRABLE_PRINCIPAL_KINDS = [
  "agent",
  "routine",
  "integration_adapter",
  "api",
  "service",
] as const;

export const PrincipalViewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "status", "expiresAt"],
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    status: { type: "string", enum: ["active", "disabled", "expired"] },
    expiresAt: { type: ["string", "null"] },
  },
} as const;

export const GrantSchema = {
  type: "object",
  additionalProperties: false,
  required: ["effect", "action", "resourceType", "label"],
  properties: {
    effect: { type: "string", enum: ["allow", "deny"] },
    action: { type: "string" },
    resourceType: { type: "string" },
    label: { type: "string" },
  },
} as const;

export const RoleViewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "displayName",
    "slug",
    "source",
    "assignableTo",
    "parentRoleIds",
    "grants",
    "expiresAt",
  ],
  properties: {
    id: { type: "string" },
    displayName: { type: ["string", "null"] },
    slug: { type: ["string", "null"] },
    source: { type: "string", enum: ["builtin", "authored"] },
    assignableTo: { type: "array", items: { type: "string" } },
    parentRoleIds: { type: "array", items: { type: "string" } },
    grants: { type: "array", items: GrantSchema },
    expiresAt: { type: ["string", "null"] },
  },
} as const;

export const AssigneeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["principalId", "expiresAt"],
  properties: {
    principalId: { type: "string" },
    expiresAt: { type: ["string", "null"] },
  },
} as const;

export const GroupViewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "expiresAt"],
  properties: {
    id: { type: "string" },
    expiresAt: { type: ["string", "null"] },
  },
} as const;

export const GroupDetailSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "expiresAt", "members", "roles"],
  properties: {
    id: { type: "string" },
    expiresAt: { type: ["string", "null"] },
    members: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["principalId", "expiresAt"],
        properties: {
          principalId: { type: "string" },
          expiresAt: { type: ["string", "null"] },
        },
      },
    },
    roles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["roleId", "expiresAt"],
        properties: {
          roleId: { type: "string" },
          expiresAt: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

export const EffectiveGrantsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["principalId", "kind", "grants"],
  properties: {
    principalId: { type: "string" },
    kind: { type: "string" },
    grants: { type: "array", items: GrantSchema },
    // Present only when `grants` is empty. Six structurally different situations produce an empty
    // grant set and only one is unremarkable; without this an operator reads a lockout caused by a
    // dangling Role assignment as "this principal simply holds nothing".
    emptyReason: {
      type: "string",
      enum: [
        "no-such-principal",
        "not-authenticatable",
        "assignment-read-failed",
        "no-roles-assigned",
        "roles-grant-nothing",
        "unknown-role",
        "role-not-assignable",
        "grant-collection-failed",
      ],
    },
    unresolvedRoleIds: { type: "array", items: { type: "string" } },
  },
} as const;

export const ExplainSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "principalId",
    "kind",
    "allowed",
    "reason",
    "evaluatedLayers",
    "unevaluatedLayers",
    "partial",
  ],
  properties: {
    principalId: { type: "string" },
    kind: { type: "string" },
    allowed: { type: "boolean" },
    reason: {
      type: "string",
      enum: ["allowed", "no_layers", "explicit_deny", "no_matching_allow"],
    },
    deniedLayer: { type: "string" },
    evaluatedLayers: { type: "array", items: { type: "string" } },
    unevaluatedLayers: { type: "array", items: { type: "string" } },
    // Why an evaluated layer resolved to no grants, keyed by layer name. A denial attributed to a
    // layer that emptied because of a dangling Role assignment is a data fault, not a policy
    // decision, and must not be read as one.
    layerEmptyReasons: {
      type: "object",
      additionalProperties: {
        type: "string",
        enum: [
          "no-such-principal",
          "not-authenticatable",
          "assignment-read-failed",
          "no-roles-assigned",
          "roles-grant-nothing",
          "unknown-role",
          "role-not-assignable",
          "grant-collection-failed",
        ],
      },
    },
    unresolvedRoleIds: { type: "array", items: { type: "string" } },
    partial: { type: "boolean" },
  },
} as const;

export const OkSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", const: "ok" } },
} as const;

export const IsoDateTime = { type: "string", format: "date-time" } as const;
