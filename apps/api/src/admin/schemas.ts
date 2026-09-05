export const AdminIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", minLength: 1 } },
} as const;

export const AdminErrorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          additionalProperties: false,
          required: ["version", "code", "message", "correlationId", "retryable"],
          properties: {
            version: { type: "string", const: "1" },
            code: { type: "string" },
            message: { type: "string" },
            correlationId: { type: "string" },
            retryable: { type: "boolean" },
          },
        },
      ],
    },
  },
} as const;

export const AdminRunSchema = {
  type: "object",
  additionalProperties: true,
  required: [
    "id",
    "routineId",
    "routineVersion",
    "status",
    "version",
    "createdAt",
    "startedAt",
    "finishedAt",
    "states",
    "effects",
    "waits",
    "guardrailDecisions",
    "lineage",
    "costs",
  ],
  properties: {
    id: { type: "string" },
    routineId: { type: "string" },
    routineVersion: { type: "string" },
    status: { type: "string" },
    version: { type: "integer" },
    createdAt: { type: "string" },
    startedAt: { type: ["string", "null"] },
    finishedAt: { type: ["string", "null"] },
    states: { type: "array", items: { type: "object", additionalProperties: true } },
    effects: { type: "array", items: { type: "object", additionalProperties: true } },
    waits: { type: "array", items: { type: "object", additionalProperties: true } },
    guardrailDecisions: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    lineage: { type: "array", items: { type: "object", additionalProperties: true } },
    costs: {
      type: "object",
      required: ["amountUsd", "modelTokens"],
      properties: { amountUsd: { type: "number" }, modelTokens: { type: "number" } },
    },
  },
} as const;

export const AdminRunBudgetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "limit", "consumed", "exhaustionPolicy"],
  properties: {
    key: { type: "string" },
    limit: { type: "integer" },
    consumed: { type: "integer" },
    exhaustionPolicy: { type: "string", enum: ["failure_path", "attention_required"] },
  },
} as const;

export const AdminRunListQuerystringSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
} as const;

export const AdminRunListResponseSchema = {
  type: "object",
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", items: AdminRunSchema },
    nextCursor: { type: ["string", "null"] },
  },
} as const;

export const AdminRunListResponsesSchema = {
  200: AdminRunListResponseSchema,
  403: AdminErrorSchema,
} as const;

export const AdminRunResponseSchema = {
  type: "object",
  required: ["run"],
  properties: { run: AdminRunSchema },
} as const;

export const AdminRunResponsesSchema = {
  200: AdminRunResponseSchema,
  403: AdminErrorSchema,
  404: AdminErrorSchema,
} as const;

export const AdminRunBudgetsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runId", "budgets"],
  properties: {
    runId: { type: "string" },
    budgets: { type: "array", items: AdminRunBudgetSchema },
  },
} as const;

export const AdminRunBudgetsResponsesSchema = {
  200: AdminRunBudgetsResponseSchema,
  401: AdminErrorSchema,
  403: AdminErrorSchema,
  404: AdminErrorSchema,
} as const;

export const AdminIdempotencyKeyHeadersSchema = {
  type: "object",
  properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 200 } },
} as const;

export const AdminRunCommandBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion", "reason"],
  properties: {
    expectedVersion: { type: "integer", minimum: 0 },
    reason: { type: "string", minLength: 1, maxLength: 500 },
  },
} as const;

export const AdminRunCommandResponseSchema = {
  type: "object",
  required: ["commandId", "runId", "status"],
  properties: {
    commandId: { type: "string" },
    runId: { type: "string" },
    status: { type: "string", enum: ["accepted", "duplicate"] },
  },
} as const;

export const AdminRunCommandResponsesSchema = {
  202: AdminRunCommandResponseSchema,
  400: AdminErrorSchema,
  403: AdminErrorSchema,
  404: AdminErrorSchema,
  409: AdminErrorSchema,
  501: AdminErrorSchema,
} as const;

export const AdminOperationsResponseSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export const AdminOperationsResponsesSchema = {
  200: AdminOperationsResponseSchema,
  403: AdminErrorSchema,
} as const;

export const AdminTeamMigrationReportResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "legacyGroupId",
          "teamId",
          "teamSlug",
          "displayName",
          "slugConflict",
          "siblingNameConflict",
          "migratedAt",
        ],
        properties: {
          legacyGroupId: { type: "string" },
          teamId: { type: "string" },
          teamSlug: { type: "string" },
          displayName: { type: "string" },
          slugConflict: { type: "boolean" },
          siblingNameConflict: { type: "boolean" },
          migratedAt: { type: "string" },
        },
      },
    },
  },
} as const;

export const AdminTeamMigrationReportResponsesSchema = {
  200: AdminTeamMigrationReportResponseSchema,
  403: AdminErrorSchema,
} as const;

export const AdminGuardrailsResponseSchema = {
  type: "object",
  required: ["revision", "items"],
  properties: {
    revision: { type: "string" },
    items: { type: "array", items: { type: "object", additionalProperties: true } },
  },
} as const;

export const AdminGuardrailsResponsesSchema = {
  200: AdminGuardrailsResponseSchema,
  403: AdminErrorSchema,
} as const;

export const AdminGuardrailChangesetBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["baseRevision", "changes"],
  properties: {
    baseRevision: { type: "string", minLength: 1 },
    changes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "path"],
        properties: {
          op: { type: "string", enum: ["add", "remove", "replace"] },
          path: { type: "string", minLength: 1 },
          value: {},
        },
      },
    },
  },
} as const;

export const AdminChangesetResponseSchema = {
  type: "object",
  required: ["changesetId", "status"],
  properties: {
    changesetId: { type: "string" },
    status: {
      type: "string",
      enum: ["validated", "awaiting_approval", "published"],
    },
  },
} as const;

export const AdminGuardrailChangesetResponsesSchema = {
  202: AdminChangesetResponseSchema,
  400: AdminErrorSchema,
  403: AdminErrorSchema,
  409: AdminErrorSchema,
  501: AdminErrorSchema,
} as const;

export const AdminAgentChangesetBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["baseVersion", "candidateVersion", "patch"],
  properties: {
    baseVersion: { type: "string", minLength: 1 },
    candidateVersion: { type: "string", minLength: 1 },
    patch: { type: "object", additionalProperties: true },
  },
} as const;

export const AdminAgentChangesetResponseSchema = {
  type: "object",
  required: ["changesetId", "candidateVersion", "status"],
  properties: {
    changesetId: { type: "string" },
    candidateVersion: { type: "string" },
    status: {
      type: "string",
      enum: ["validated", "awaiting_approval", "published"],
    },
  },
} as const;

export const AdminAgentChangesetResponsesSchema = {
  202: AdminAgentChangesetResponseSchema,
  400: AdminErrorSchema,
  403: AdminErrorSchema,
  409: AdminErrorSchema,
  501: AdminErrorSchema,
} as const;

export const AdminInboxResponseSchema = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
} as const;

export const AdminInboxResponsesSchema = {
  200: AdminInboxResponseSchema,
  403: AdminErrorSchema,
} as const;

export const AdminApprovalDecisionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision"],
  properties: {
    decision: { type: "string", enum: ["approved", "denied"] },
    comment: { type: "string", maxLength: 1000 },
    representedTeamId: { type: "string", format: "uuid" },
  },
} as const;

export const AdminApprovalDecisionResponseSchema = {
  type: "object",
  required: ["approvalId", "status", "decisions", "requiredDecisions"],
  properties: {
    approvalId: { type: "string" },
    status: { type: "string", enum: ["pending", "approved", "denied"] },
    decisions: { type: "integer" },
    requiredDecisions: { type: "integer" },
  },
} as const;

export const AdminApprovalDecisionResponsesSchema = {
  200: AdminApprovalDecisionResponseSchema,
  400: AdminErrorSchema,
  403: AdminErrorSchema,
  404: AdminErrorSchema,
  409: AdminErrorSchema,
} as const;

export const AdminRolesResponseSchema = {
  type: "object",
  required: ["revision", "items"],
  properties: {
    revision: { type: "string" },
    items: { type: "array", items: { type: "object", additionalProperties: true } },
  },
} as const;

export const AdminRolesResponsesSchema = {
  200: AdminRolesResponseSchema,
  403: AdminErrorSchema,
} as const;

export const AdminRoleChangesetBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["baseRevision", "role"],
  properties: {
    baseRevision: { type: "string", minLength: 1 },
    role: { type: "object", additionalProperties: true },
  },
} as const;

export const AdminRoleChangesetResponsesSchema = {
  202: AdminChangesetResponseSchema,
  400: AdminErrorSchema,
  403: AdminErrorSchema,
  409: AdminErrorSchema,
  501: AdminErrorSchema,
} as const;

export const AdminOperationActionParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["support-bundle.create", "kill-switch.set", "quarantine.resolve", "recovery.start"],
    },
  },
} as const;

export const AdminOperationCommandHeadersSchema = {
  type: "object",
  properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 500 } },
} as const;

export const AdminOperationCommandBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["input"],
  properties: { input: { type: "object", additionalProperties: true } },
} as const;

export const AdminOperationCommandResponseSchema = {
  type: "object",
  required: ["commandId", "status"],
  properties: {
    commandId: { type: "string" },
    status: { type: "string", enum: ["accepted", "duplicate"] },
  },
} as const;

export const AdminOperationCommandResponsesSchema = {
  202: AdminOperationCommandResponseSchema,
  400: AdminErrorSchema,
  403: AdminErrorSchema,
  409: AdminErrorSchema,
  501: AdminErrorSchema,
} as const;
