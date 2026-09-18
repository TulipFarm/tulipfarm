import { type Static, Type } from "@sinclair/typebox";
import { ajv } from "./ajv";

const text = Type.String({ minLength: 1, maxLength: 1024 });
const timestamp = Type.String({ format: "date-time" });
const failureCodes = [
  "unsupported_source",
  "unsupported_shared_sync",
  "invalid_selection",
  "identity_mismatch",
  "source_unavailable",
  "source_too_large",
  "source_response_invalid",
  "selection_changed",
  "publication_failed",
] as const;
export const McpKnowledgeFileSchema = Type.Object(
  { owner: text, repo: text, path: text, ref: text },
  { additionalProperties: false }
);
export const McpKnowledgeBindingSchema = Type.Object(
  {
    businessId: text,
    integrationId: text,
    accountId: text,
    accountRevision: Type.Integer({ minimum: 1 }),
    ownerUserId: text,
    externalAccountId: text,
    configurationRevision: text,
  },
  { additionalProperties: false }
);
export const McpKnowledgeSelectionSchema = Type.Object(
  {
    id: text,
    revision: Type.String({ pattern: "^[1-9][0-9]{0,15}$" }),
    binding: McpKnowledgeBindingSchema,
    visibility: Type.Union([Type.Literal("personal"), Type.Literal("shared")]),
    enabled: Type.Boolean(),
    files: Type.Array(McpKnowledgeFileSchema, { minItems: 1, maxItems: 1000 }),
    pollIntervalMs: Type.Optional(Type.Integer({ minimum: 60_000, maximum: 86_400_000 })),
  },
  { additionalProperties: false }
);
export type McpKnowledgeSelectionDocument = Static<typeof McpKnowledgeSelectionSchema>;
export const McpKnowledgeCheckpointSchema = Type.Object(
  {
    selectionRevision: text,
    nextIndex: Type.Integer({ minimum: 0, maximum: 1000 }),
    synced: Type.Integer({ minimum: 0, maximum: 1000 }),
    failed: Type.Integer({ minimum: 0, maximum: 1000 }),
    complete: Type.Boolean(),
    failures: Type.Array(
      Type.Object({
        index: Type.Integer({ minimum: 0, maximum: 999 }),
        code: Type.Union(failureCodes.map((code) => Type.Literal(code))),
      }),
      { maxItems: 1000 }
    ),
    updatedAt: timestamp,
  },
  { additionalProperties: false }
);
export type McpKnowledgeCheckpointDocument = Static<typeof McpKnowledgeCheckpointSchema>;
export const McpKnowledgePutSchema = Type.Object(
  {
    expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
    enabled: Type.Boolean(),
    files: Type.Array(McpKnowledgeFileSchema, { minItems: 1, maxItems: 1000 }),
    pollIntervalMs: Type.Optional(Type.Integer({ minimum: 60_000, maximum: 86_400_000 })),
  },
  { additionalProperties: false }
);
export type McpKnowledgePut = Static<typeof McpKnowledgePutSchema>;
export const McpKnowledgeVersionSchema = Type.Object(
  { expectedRevision: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false }
);
export const McpKnowledgeStatusSchema = Type.Object({
  eligibility: Type.Object({
    supported: Type.Boolean(),
    reason: Type.Union([Type.Null(), Type.String()]),
    sourceKind: Type.Literal("github-file"),
    visibility: Type.Literal("personal"),
  }),
  selection: Type.Union([
    Type.Null(),
    Type.Object({
      id: text,
      revision: Type.Integer({ minimum: 1 }),
      enabled: Type.Boolean(),
      files: Type.Array(McpKnowledgeFileSchema),
      pollIntervalMs: Type.Integer(),
      progress: Type.Union([Type.Null(), McpKnowledgeCheckpointSchema]),
      lastAttemptAt: Type.Union([Type.Null(), timestamp]),
      lastCompletedAt: Type.Union([Type.Null(), timestamp]),
      nextAttemptAt: timestamp,
      errorCode: Type.Union([Type.Null(), Type.String()]),
      cleanupPending: Type.Integer({ minimum: 0 }),
    }),
  ]),
});
export type McpKnowledgeStatus = Static<typeof McpKnowledgeStatusSchema>;

const checkSelection = ajv.compile<McpKnowledgeSelectionDocument>(McpKnowledgeSelectionSchema);
const checkCheckpoint = ajv.compile<McpKnowledgeCheckpointDocument>(McpKnowledgeCheckpointSchema);

export function validateMcpKnowledgeSelectionDocument(
  value: unknown
): McpKnowledgeSelectionDocument {
  if (!checkSelection(value)) throw new Error("invalid_mcp_knowledge_selection");
  return value;
}

export function validateMcpKnowledgeCheckpointDocument(
  value: unknown
): McpKnowledgeCheckpointDocument {
  if (!checkCheckpoint(value)) throw new Error("invalid_mcp_knowledge_checkpoint");
  return value;
}
