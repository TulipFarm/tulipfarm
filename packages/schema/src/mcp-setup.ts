import { type Static, Type } from "@sinclair/typebox";
import { McpCapabilityReviewSchema, McpIntegrationDefinitionSchema } from "./mcp";
import { validate } from "./validate";

const id = Type.String({ minLength: 1, maxLength: 256 });
export const McpSetupAccessSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    state: Type.Union([
      Type.Literal("allowed"),
      Type.Literal("preserved_empty"),
      Type.Literal("discovered_empty"),
      Type.Literal("initial_empty"),
      Type.Literal("uninitialized"),
    ]),
    tools: Type.Integer({ minimum: 0 }),
    resources: Type.Integer({ minimum: 0 }),
    prompts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false }
);
export type McpSetupAccess = Static<typeof McpSetupAccessSchema>;
export const McpSetupAccountSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 128 }),
    scope: Type.Union([Type.Literal("personal"), Type.Literal("shared")]),
    authentication: Type.Union([
      Type.Literal("token"),
      Type.Literal("oauth"),
      Type.Literal("none"),
    ]),
    oauthClient: Type.Optional(
      Type.Object(
        {
          clientId: Type.String({ minLength: 1, maxLength: 2048 }),
          tokenEndpointAuthMethod: Type.Union([
            Type.Literal("none"),
            Type.Literal("client_secret_basic"),
            Type.Literal("client_secret_post"),
          ]),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);
export const McpSetupCredentialsSchema = Type.Object(
  {
    values: Type.Optional(
      Type.Record(
        Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }),
        Type.String({ minLength: 1, maxLength: 16_384 }),
        { maxProperties: 32 }
      )
    ),
    clientSecret: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
  },
  { additionalProperties: false }
);
export const McpSetupStartSchema = Type.Object(
  {
    ...McpSetupCredentialsSchema.properties,
    providerId: Type.Optional(id),
    integrationKey: Type.Optional(id),
    definitionRevision: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    authentication: Type.Optional(Type.Union([Type.Literal("token"), Type.Literal("oauth")])),
    accountId: Type.Optional(id),
    account: Type.Optional(McpSetupAccountSchema),
    initializePolicy: Type.Boolean(),
    legacyEmptyPolicyConsent: Type.Optional(Type.Literal("use_standard_access")),
    confirmShared: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);
export const McpSetupEligibilitySchema = Type.Object(
  {
    definitionRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    policy: Type.Union([Type.Literal("initialize"), Type.Literal("preserve")]),
    publishedReady: Type.Boolean(),
    canConfigure: Type.Boolean(),
    canUseStandardAccess: Type.Boolean(),
    access: Type.Optional(McpSetupAccessSchema),
  },
  { additionalProperties: false }
);
export const McpSetupStatusSchema = Type.Object(
  {
    id,
    integrationKey: id,
    accountId: Type.Optional(id),
    status: Type.Union([
      Type.Literal("needs_credentials"),
      Type.Literal("needs_sign_in"),
      Type.Literal("needs_admin"),
      Type.Literal("retry"),
      Type.Literal("done"),
    ]),
    error: Type.Optional(Type.String()),
    access: Type.Optional(McpSetupAccessSchema),
  },
  { additionalProperties: false }
);
export const McpSetupOperationSchema = Type.Object(
  {
    ...McpSetupStatusSchema.properties,
    businessId: id,
    principalId: id,
    intentDigest: Type.String(),
    baseline: McpIntegrationDefinitionSchema,
    baseRevision: Type.Union([Type.String(), Type.Null()]),
    account: Type.Optional(McpSetupAccountSchema),
    initializePolicy: Type.Boolean(),
    legacyEmptyPolicyConsent: Type.Optional(Type.Literal("use_standard_access")),
    confirmShared: Type.Boolean(),
    accountRevision: Type.Optional(Type.Integer()),
    snapshot: Type.Optional(McpCapabilityReviewSchema),
    desired: Type.Optional(McpIntegrationDefinitionSchema),
  },
  { additionalProperties: false }
);
export type McpSetupOperation = Static<typeof McpSetupOperationSchema>;
export type McpSetupStart = Static<typeof McpSetupStartSchema>;
export type McpSetupCredentials = Static<typeof McpSetupCredentialsSchema>;
export type McpSetupStatus = Static<typeof McpSetupStatusSchema>;
export type McpSetupEligibility = Static<typeof McpSetupEligibilitySchema>;
export function validateMcpSetupOperation(value: unknown): McpSetupOperation {
  validate("integration", McpSetupOperationSchema, value);
  return value;
}
