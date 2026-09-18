import { type Static, Type } from "@sinclair/typebox";
import { OPAQUE_SECRET_REFERENCE_PATTERN } from "./definitions/enums";
import { validate } from "./validate";

const id = Type.String({ minLength: 1, maxLength: 256 });
const integrationKey = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z0-9][a-z0-9-]*$",
});
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const timestamp = Type.String({ format: "date-time" });
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const authentication = Type.Unsafe<"none" | "token" | "oauth">({
  type: "string",
  enum: ["none", "token", "oauth"],
});
const oauthClient = Type.Object(
  {
    clientId: Type.String({ minLength: 1, maxLength: 2048 }),
    tokenEndpointAuthMethod: Type.Union([
      Type.Literal("none"),
      Type.Literal("client_secret_basic"),
      Type.Literal("client_secret_post"),
    ]),
  },
  { additionalProperties: false }
);

export const McpAccountOwnerSchema = Type.Union([
  Type.Object(
    { scope: Type.Literal("personal"), principalId: id },
    { additionalProperties: false }
  ),
  Type.Object({ scope: Type.Literal("shared") }, { additionalProperties: false }),
]);

export const McpAccountSchema = Type.Object(
  {
    id,
    businessId: id,
    integrationKey,
    definitionDigest: digest,
    label: Type.String({ minLength: 1, maxLength: 128 }),
    owner: McpAccountOwnerSchema,
    status: Type.Unsafe<"pending" | "active" | "action_required" | "revoked">({
      type: "string",
      enum: ["pending", "active", "action_required", "revoked"],
    }),
    authentication,
    oauthClient: Type.Optional(oauthClient),
    isDefault: Type.Boolean(),
    revision,
    secretBindings: Type.Record(
      Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }),
      Type.String({ pattern: OPAQUE_SECRET_REFERENCE_PATTERN }),
      { additionalProperties: false, maxProperties: 32 }
    ),
    expiresAt: Type.Union([timestamp, Type.Null()]),
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  { additionalProperties: false }
);

export const McpAccountSummarySchema = Type.Omit(McpAccountSchema, ["secretBindings"]);
export const McpOAuthConfigurationSchema = Type.Object(
  { callbackUrl: Type.String({ format: "uri", maxLength: 2048 }) },
  { additionalProperties: false }
);
export type McpOAuthConfiguration = Static<typeof McpOAuthConfigurationSchema>;

export const McpAccountGrantSchema = Type.Object(
  {
    businessId: id,
    accountId: id,
    accountRevision: revision,
    subject: Type.Union([
      Type.Object({ kind: Type.Literal("user"), id }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("team"), id }, { additionalProperties: false }),
      Type.Object(
        { kind: Type.Literal("routine"), id, configurationDigest: digest },
        { additionalProperties: false }
      ),
      Type.Object(
        { kind: Type.Literal("knowledge_sync"), id, configurationDigest: digest },
        { additionalProperties: false }
      ),
    ]),
    grantedBy: id,
    grantedAt: timestamp,
  },
  { additionalProperties: false }
);

export const McpChatAccountSelectionSchema = Type.Object(
  {
    businessId: id,
    conversationId: id,
    principalId: id,
    integrationKey,
    accountId: id,
    accountRevision: revision,
    definitionDigest: digest,
    sharedConsent: Type.Boolean(),
    selectedAt: timestamp,
  },
  { additionalProperties: false }
);

export const McpAccountCreateSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 128 }),
    scope: Type.Unsafe<"personal" | "shared">({
      type: "string",
      enum: ["personal", "shared"],
    }),
    authentication,
    oauthClient: Type.Optional(
      Type.Object(
        {
          ...oauthClient.properties,
          clientSecret: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
        },
        { additionalProperties: false }
      )
    ),
    isDefault: Type.Optional(Type.Boolean()),
    values: Type.Optional(
      Type.Record(
        Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }),
        Type.String({ minLength: 1, maxLength: 16_384 }),
        { additionalProperties: false, maxProperties: 32 }
      )
    ),
  },
  { additionalProperties: false }
);

export const McpAccountSelectionRequestSchema = Type.Object(
  {
    accountId: id,
    confirmShared: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const McpExecutionBindingSchema = Type.Object(
  {
    serverId: id,
    serverRevision: digest,
    accountId: Type.Union([id, Type.Null()]),
    accountRevision: id,
    subjectId: id,
    authorizationId: id,
  },
  { additionalProperties: false }
);

export type McpExecutionBinding = Static<typeof McpExecutionBindingSchema>;
export const McpExecutionAuthorizationSchema = Type.Object(
  {
    businessId: id,
    binding: McpExecutionBindingSchema,
    contextDigest: digest,
    caller: Type.Object(
      {
        principal: Type.Object({ kind: id, id }, { additionalProperties: false }),
        runId: Type.Optional(id),
        conversationId: Type.Optional(id),
        routineId: Type.Optional(id),
        accountId: Type.Optional(id),
        knowledgeSyncId: Type.Optional(id),
      },
      { additionalProperties: false }
    ),
    capability: Type.Union([
      Type.Object({ kind: Type.Literal("tool"), name: id }, { additionalProperties: false }),
      Type.Object(
        { kind: Type.Literal("resource"), name: Type.String({ minLength: 1, maxLength: 4096 }) },
        { additionalProperties: false }
      ),
      Type.Object({ kind: Type.Literal("prompt"), name: id }, { additionalProperties: false }),
      Type.Object(
        { kind: Type.Literal("discovery"), name: Type.Literal("*") },
        { additionalProperties: false }
      ),
    ]),
  },
  { additionalProperties: false }
);
export type McpExecutionAuthorization = Static<typeof McpExecutionAuthorizationSchema>;

export function validateMcpExecutionAuthorization(value: unknown): McpExecutionAuthorization {
  validate("integration", McpExecutionAuthorizationSchema, value);
  return value;
}

export type McpAccount = Static<typeof McpAccountSchema>;
export type McpAccountSummary = Static<typeof McpAccountSummarySchema>;
export type McpAccountOwner = Static<typeof McpAccountOwnerSchema>;
export type McpAccountGrant = Static<typeof McpAccountGrantSchema>;
export type McpChatAccountSelection = Static<typeof McpChatAccountSelectionSchema>;
export type McpAccountCreate = Static<typeof McpAccountCreateSchema>;
export type McpAccountSelectionRequest = Static<typeof McpAccountSelectionRequestSchema>;

export function validateMcpAccount(value: unknown): McpAccount {
  validate("integration", McpAccountSchema, value);
  return value;
}

export function validateMcpAccountGrant(value: unknown): McpAccountGrant {
  validate("integration", McpAccountGrantSchema, value);
  return value;
}

export function validateMcpChatAccountSelection(value: unknown): McpChatAccountSelection {
  validate("integration", McpChatAccountSelectionSchema, value);
  return value;
}
