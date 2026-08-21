import { type Static, Type } from "@sinclair/typebox";
import { ajv } from "./ajv";
import { TulipFarmValidationError } from "./error";

const MCP_TRANSPORTS = ["stdio", "sse"] as const;
const EGRESS_AUTH_LOCATIONS = ["header", "base_url"] as const;
const APP_MANIFEST_DELIVERIES = ["form_post", "query_param"] as const;
const OAUTH_GRANTS = ["authorization_code", "client_credentials"] as const;
const WEBHOOK_METHODS = ["POST", "PUT"] as const;

const StringRecordSchema = Type.Record(Type.String({ minLength: 1 }), Type.String());
const UnknownRecordSchema = Type.Record(Type.String({ minLength: 1 }), Type.Unknown());

const RequiredEnvVarSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    secret: Type.Optional(Type.Boolean()),
    setup_url: Type.Optional(Type.String()),
    steps: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true }
);

const EgressAuthSchema = Type.Object(
  {
    token_env: Type.String({ minLength: 1 }),
    in: Type.Optional(
      Type.Unsafe<(typeof EGRESS_AUTH_LOCATIONS)[number]>({
        type: "string",
        enum: [...EGRESS_AUTH_LOCATIONS],
      })
    ),
    header: Type.Optional(Type.String({ minLength: 1 })),
    format: Type.Optional(Type.String()),
  },
  { additionalProperties: true }
);

const EgressOperationSchema = Type.Object(
  {
    operation: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    mutating: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true }
);

const GraphqlEgressOperationSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    operation: Type.String({ minLength: 1 }),
    document: Type.String({ minLength: 1 }),
    variables_schema: UnknownRecordSchema,
  },
  { additionalProperties: true }
);

const EgressSchema = Type.Union([
  Type.Object({ type: Type.Literal("none") }, { additionalProperties: true }),
  Type.Object(
    {
      type: Type.Literal("mcp"),
      entry: Type.Object(
        {
          transport: Type.Unsafe<(typeof MCP_TRANSPORTS)[number]>({
            type: "string",
            enum: [...MCP_TRANSPORTS],
          }),
          command: Type.Optional(Type.String({ minLength: 1 })),
          args: Type.Optional(Type.Array(Type.String())),
          url: Type.Optional(Type.String({ minLength: 1 })),
          headers: Type.Optional(StringRecordSchema),
        },
        { additionalProperties: true }
      ),
    },
    { additionalProperties: true }
  ),
  Type.Object(
    {
      type: Type.Literal("graphql"),
      url: Type.String({ minLength: 1 }),
      operations: Type.Optional(Type.Array(GraphqlEgressOperationSchema)),
      auth: Type.Optional(EgressAuthSchema),
      headers: Type.Optional(StringRecordSchema),
    },
    { additionalProperties: true }
  ),
  Type.Object(
    {
      type: Type.Literal("openapi"),
      spec: Type.String({ minLength: 1 }),
      operations: Type.Optional(Type.Array(EgressOperationSchema)),
      base_url: Type.Optional(Type.String({ minLength: 1 })),
      auth: Type.Optional(EgressAuthSchema),
      headers: Type.Optional(StringRecordSchema),
    },
    { additionalProperties: true }
  ),
  Type.Object(
    {
      type: Type.Literal("ts-code"),
      handler: Type.String({ minLength: 1 }),
      toolsSpec: Type.String({ minLength: 1 }),
    },
    { additionalProperties: true }
  ),
]);

const IntegrationGrantSchema = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    access: Type.Optional(Type.String({ minLength: 1 })),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: true }
);

const AuthExchangeSchema = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
    map: StringRecordSchema,
    secret_envs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
  },
  { additionalProperties: true }
);

const AuthFieldsStepSchema = Type.Object(
  {
    kind: Type.Literal("fields"),
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    fields: Type.Array(RequiredEnvVarSchema, { minItems: 1 }),
  },
  { additionalProperties: true }
);

const AuthAppManifestStepSchema = Type.Object(
  {
    kind: Type.Literal("app_manifest"),
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    create_url: Type.String({ minLength: 1 }),
    delivery: Type.Unsafe<(typeof APP_MANIFEST_DELIVERIES)[number]>({
      type: "string",
      enum: [...APP_MANIFEST_DELIVERIES],
    }),
    manifest_param: Type.String({ minLength: 1 }),
    manifest: UnknownRecordSchema,
    exchange: Type.Optional(AuthExchangeSchema),
  },
  { additionalProperties: true }
);

const AuthOAuth2StepSchema = Type.Object(
  {
    kind: Type.Literal("oauth2"),
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    grant: Type.Optional(
      Type.Unsafe<(typeof OAUTH_GRANTS)[number]>({ type: "string", enum: [...OAUTH_GRANTS] })
    ),
    /**
     * Whether the returned token represents the authorizing person rather than the installation.
     * Declared, never inferred from `grant`: Slack's install step is `authorization_code` and
     * returns a workspace bot token.
     */
    personal: Type.Optional(Type.Boolean()),
    authorization_url: Type.Optional(Type.String({ minLength: 1 })),
    token_url: Type.String({ minLength: 1 }),
    refresh_url: Type.Optional(Type.String({ minLength: 1 })),
    scopes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    scope_separator: Type.Optional(Type.String()),
    pkce: Type.Optional(Type.Boolean()),
    authorize_params: Type.Optional(StringRecordSchema),
    client_id_env: Type.String({ minLength: 1 }),
    client_secret_env: Type.String({ minLength: 1 }),
    token_env: Type.String({ minLength: 1 }),
    refresh_token_env: Type.Optional(Type.String({ minLength: 1 })),
    expires_at_env: Type.Optional(Type.String({ minLength: 1 })),
    token_response_path: Type.Optional(Type.String({ minLength: 1 })),
    map: Type.Optional(StringRecordSchema),
  },
  { additionalProperties: true }
);

const AuthInstallStepSchema = Type.Object(
  {
    kind: Type.Literal("install"),
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    url: Type.String({ minLength: 1 }),
    capture: Type.Optional(StringRecordSchema),
  },
  { additionalProperties: true }
);

const AuthWebhookStepSchema = Type.Object(
  {
    kind: Type.Literal("webhook"),
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    url: Type.String({ minLength: 1 }),
    method: Type.Optional(
      Type.Unsafe<(typeof WEBHOOK_METHODS)[number]>({ type: "string", enum: [...WEBHOOK_METHODS] })
    ),
    secret_env: Type.Optional(Type.String({ minLength: 1 })),
    body: Type.Optional(UnknownRecordSchema),
    map: Type.Optional(StringRecordSchema),
  },
  { additionalProperties: true }
);

const AuthStepSchema = Type.Union([
  AuthFieldsStepSchema,
  AuthAppManifestStepSchema,
  AuthOAuth2StepSchema,
  AuthInstallStepSchema,
  AuthWebhookStepSchema,
]);

const BodyMatchSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    equals: Type.String(),
  },
  { additionalProperties: true }
);

const WebhookSecuritySchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("hmac_sha256"),
      header: Type.String({ minLength: 1 }),
      secret_env: Type.String({ minLength: 1 }),
      signing: Type.Optional(Type.String()),
      format: Type.Optional(Type.String()),
      timestamp_header: Type.Optional(Type.String({ minLength: 1 })),
      tolerance_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: true }
  ),
  Type.Object(
    {
      type: Type.Literal("shared_secret"),
      header: Type.String({ minLength: 1 }),
      secret_env: Type.String({ minLength: 1 }),
    },
    { additionalProperties: true }
  ),
]);

const ToolBindingSchema = Type.Object(
  {
    tool: Type.String({ minLength: 1 }),
    args: UnknownRecordSchema,
  },
  { additionalProperties: true }
);

const IngressSchema = Type.Object(
  {
    spec: Type.Optional(Type.String({ minLength: 1 })),
    handler: Type.String({ minLength: 1 }),
    webhook: Type.Object(
      {
        security: WebhookSecuritySchema,
        handshake: Type.Optional(
          Type.Object(
            {
              match: BodyMatchSchema,
              respond: StringRecordSchema,
            },
            { additionalProperties: true }
          )
        ),
        accept: Type.Optional(BodyMatchSchema),
        dedup_key: Type.Optional(Type.String({ minLength: 1 })),
        dedup_header: Type.Optional(Type.String({ minLength: 1 })),
        context_headers: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      },
      { additionalProperties: true }
    ),
    context_env: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    chat: Type.Optional(
      Type.Object(
        {
          thread_key: Type.String({ minLength: 1 }),
          identity: Type.Optional(
            Type.Object(
              {
                tool: Type.String({ minLength: 1 }),
                args: UnknownRecordSchema,
                email_path: Type.String({ minLength: 1 }),
              },
              { additionalProperties: true }
            )
          ),
          reply: Type.Record(Type.String({ minLength: 1 }), ToolBindingSchema),
        },
        { additionalProperties: true }
      )
    ),
    events: Type.Optional(
      Type.Object(
        { types: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) },
        { additionalProperties: true }
      )
    ),
  },
  { additionalProperties: true }
);

const OAuthFlowSchema = Type.Object(
  {
    authorizationUrl: Type.String({ minLength: 1 }),
    tokenUrl: Type.String({ minLength: 1 }),
    scopes: StringRecordSchema,
  },
  { additionalProperties: true }
);

const LegacyOAuthSchema = Type.Object(
  {
    flows: Type.Object(
      {
        authorizationCode: Type.Optional(OAuthFlowSchema),
        clientCredentials: Type.Optional(OAuthFlowSchema),
      },
      { additionalProperties: true }
    ),
    "x-tulipfarm": Type.Object(
      {
        client_id_env: Type.String({ minLength: 1 }),
        client_secret_env: Type.String({ minLength: 1 }),
        token_env: Type.String({ minLength: 1 }),
        token_response_path: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: true }
    ),
  },
  { additionalProperties: true }
);

export const LegacyIntegrationManifestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    version: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    maintainer: Type.Optional(Type.String()),
    icon: Type.Optional(Type.String()),
    capabilities: Type.Optional(Type.Array(Type.String())),
    grants: Type.Optional(Type.Array(IntegrationGrantSchema)),
    egress: EgressSchema,
    ingress: Type.Optional(IngressSchema),
    auth: Type.Optional(Type.Array(AuthStepSchema)),
    required_env: Type.Optional(Type.Array(RequiredEnvVarSchema)),
    setup_guide_path: Type.Optional(Type.String({ minLength: 1 })),
    oauth: Type.Optional(LegacyOAuthSchema),
    install_manifest: Type.Optional(UnknownRecordSchema),
  },
  { additionalProperties: true }
);

export type LegacyIntegrationManifest = Static<typeof LegacyIntegrationManifestSchema>;

const check = ajv.compile(LegacyIntegrationManifestSchema);

export function validateLegacyIntegrationManifest(data: unknown): LegacyIntegrationManifest {
  if (!check(data)) {
    const e = check.errors?.[0];
    throw new TulipFarmValidationError(
      "integration",
      e?.instancePath ?? "",
      e?.message ?? "invalid legacy integration manifest"
    );
  }
  return data as LegacyIntegrationManifest;
}
