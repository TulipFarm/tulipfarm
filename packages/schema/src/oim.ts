import { isIP } from "node:net";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type Static, Type } from "@sinclair/typebox";
import { type DocumentNode, Kind, parse as parseGraphql } from "graphql";
import { parse as parseYaml } from "yaml";
import { ajv } from "./ajv";
import { canonicalHash } from "./canonicalize";
import { OPAQUE_SECRET_REFERENCE_PATTERN } from "./definitions/enums";
import { TulipFarmValidationError } from "./error";
import { TeamIdSchema } from "./teams";

export const OIM_VERSION = "1.0" as const;

export const OIM_PROFILE_VERSIONS = {
  core: "1.2",
  auth: "1.0",
  events: "1.0",
  knowledge: "1.1",
  hooks: "1.0",
} as const;

/**
 * Every Core profile version a runtime at {@link OIM_PROFILE_VERSIONS} understands, oldest first.
 *
 * A package pins the version it was written against rather than the newest one, so declaring
 * `1.0` is a promise that it uses nothing added since. {@link oimManifestIssues} enforces that
 * promise: a `1.0` package reaching for a `1.1` construct is refused, which is what keeps a
 * version number worth reading on a runtime that only implements `1.0`.
 */
export const OIM_CORE_PROFILE_VERSIONS = ["1.0", "1.1", "1.2"] as const;
const OIM_KNOWLEDGE_PROFILE_VERSIONS = ["1.0", "1.1"] as const;

/** Constructs added in Core 1.1, named as they appear in a refusal message. */
export const OIM_CORE_1_1_FEATURES = [
  "credentialInjection.in: path",
  "secondaryCredential",
  "source.contentType",
  "parameter.value",
  "parameter.configurationField",
  "source.url configuration placeholder",
  "path configuration placeholder",
  "pagination.type: body_cursor",
] as const;

/** Constructs added in Core 1.2. */
export const OIM_CORE_1_2_FEATURES = [
  "source.contentType: multipart",
  "source.multipart",
  "response.mode: binary",
] as const;

export const OIM_FILE_ROLES = ["openapi", "graphql", "guide", "hook", "fixture"] as const;
export const OIM_EFFECT_CLASSES = [
  "read",
  "sensitive_read",
  "create",
  "update",
  "delete",
  "send",
  "admin",
] as const;
export const OIM_IDENTITY_MODES = [
  "shared_only",
  "personal_required",
  "shared_or_personal",
] as const;
export const OIM_CREDENTIAL_KINDS = [
  "api_key",
  "bearer_token",
  "oauth2_access_token",
  "oauth2_refresh_token",
  "client_secret",
  "private_key",
  "webhook_secret",
] as const;
export const OIM_CONNECTION_HEALTH_STATES = [
  "healthy",
  "expiring",
  "action_required",
  "unknown",
] as const;
/**
 * The closed suite of verification schemes the runtime implements.
 *
 * Closed on purpose: a scheme an Integration could describe freely would be a scheme the host
 * cannot audit, and the point of the profile is that signing Secrets never leave trusted code.
 * A new scheme is a runtime release, not a manifest field.
 */
export const OIM_VERIFICATION_SCHEMES = [
  "shared_secret",
  "twilio_hmac_sha1",
  "hmac_sha256",
  "hmac_sha512",
  "ed25519",
  "rsa_sha256",
  "jwt",
] as const;

export const OIM_SIGNATURE_ENCODINGS = ["hex", "base64", "base64url"] as const;

/**
 * How a retry is recognised as the same delivery.
 *
 * `none` has to be spelled out. An author who simply omits deduplication has not decided that
 * retries are safe to run twice — they have not thought about it, and the difference matters when
 * the event books a payment.
 */
export const OIM_DEDUPLICATION_KINDS = ["delivery_id_header", "body_pointer", "none"] as const;

/** What a provider needs echoed back before it will start sending. */
export const OIM_HANDSHAKE_KINDS = ["none", "echo_body_pointer", "echo_header"] as const;

export const OIM_DELIVERY_STATES = ["accepted", "normalized", "dead_letter", "discarded"] as const;

export const OIM_HOOK_KINDS = [
  "input_validate",
  "request_shape",
  "response_normalize",
  "webhook_classify",
  "content_map",
  "acl_map",
] as const;

export const OIM_CONFORMANCE_CASES = {
  core: [
    "core.manifest.strict",
    "core.package.exact-files",
    "core.operation.http",
    "core.operation.openapi",
    "core.operation.graphql",
    "core.fixtures.hermetic",
    "core.compatibility.same-major",
  ],
  auth: [
    "auth.fields.secure-submit",
    "auth.oauth2.authorization-code",
    "auth.secret.prompt-omission",
  ],
  events: ["events.delivery.verify", "events.delivery.durable", "events.normalize.typed"],
  knowledge: [
    "knowledge.operations.roles",
    "knowledge.acl.preserve",
    "knowledge.deletion.propagate",
  ],
  hooks: ["hooks.capabilities.none", "hooks.output.deterministic", "hooks.execution.bounded"],
} as const;

const HTTP_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] as const;
const PAGINATION_SCOPES = ["connection", "operation"] as const;
const SLUG_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
const TOOL_NAME_PATTERN = "^[a-z][a-z0-9_]{2,63}$";
const OPERATION_ID_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
const SLOT_PATTERN = "^[a-z][a-z0-9_]{1,63}$";
const FILE_PATH_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$";
const HTTPS_URL_PATTERN =
  "^https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[1-9][0-9]{0,4})?(?:/[^\\s]*)?$";
/**
 * A base URL whose host may carry one `{field}` placeholder, filled from an installation's
 * configuration — a customer's own Atlassian site, GitLab instance or Zendesk subdomain.
 *
 * The placeholder is deliberately confined to the host and paired with `auth.allowedOriginHosts`:
 * a manifest that could be pointed anywhere at install time would turn declared destinations into
 * a suggestion, which is the property the whole allowlist rests on.
 */
const HTTPS_URL_TEMPLATE_PATTERN =
  "^https://(?:\\{[a-z][a-z0-9_]{1,63}\\}|[A-Za-z0-9])(?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[1-9][0-9]{0,4})?(?:/[^\\s]*)?$";
/** `example.com` or `*.example.com`; never a bare `*`. */
const ORIGIN_HOST_PATTERN =
  "^(?:\\*\\.)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$";
const SEMVER_PATTERN =
  "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$";
const SHA256_PATTERN = "^[a-f0-9]{64}$";
const NonEmptyStringSchema = Type.String({ minLength: 1 });
const JsonSchemaObject = Type.Record(Type.String({ minLength: 1 }), Type.Unknown());

function stringEnum<const T extends readonly string[]>(values: T) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values] });
}

const ProfilesSchema = Type.Object(
  {
    core: stringEnum(OIM_CORE_PROFILE_VERSIONS),
    auth: Type.Optional(stringEnum([OIM_PROFILE_VERSIONS.auth] as const)),
    events: Type.Optional(stringEnum([OIM_PROFILE_VERSIONS.events] as const)),
    knowledge: Type.Optional(stringEnum(OIM_KNOWLEDGE_PROFILE_VERSIONS)),
    hooks: Type.Optional(stringEnum([OIM_PROFILE_VERSIONS.hooks] as const)),
  },
  { additionalProperties: false }
);

const MaintainerSchema = Type.Object(
  {
    name: NonEmptyStringSchema,
    url: Type.Optional(Type.String({ pattern: HTTPS_URL_PATTERN })),
  },
  { additionalProperties: false }
);

const MetadataSchema = Type.Object(
  {
    id: Type.String({ pattern: SLUG_PATTERN, maxLength: 96 }),
    name: NonEmptyStringSchema,
    version: Type.String({ pattern: SEMVER_PATTERN, maxLength: 128 }),
    description: NonEmptyStringSchema,
    license: NonEmptyStringSchema,
    maintainers: Type.Optional(Type.Array(MaintainerSchema, { minItems: 1 })),
  },
  { additionalProperties: false }
);

const CompanionFileSchema = Type.Object(
  {
    path: Type.String({ pattern: FILE_PATH_PATTERN }),
    role: stringEnum(OIM_FILE_ROLES),
    sha256: Type.String({ pattern: SHA256_PATTERN }),
  },
  { additionalProperties: false }
);

const FixtureHeadersSchema = Type.Record(Type.String({ minLength: 1 }), Type.String(), {
  additionalProperties: false,
});

const FixtureRequestShapeSchema = Type.Object(
  {
    method: Type.Optional(stringEnum(HTTP_METHODS)),
    url: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    headers: Type.Optional(FixtureHeadersSchema),
    body: Type.Optional(Type.Unknown()),
    bodyText: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);

const FixtureResponseSchema = Type.Object(
  {
    status: Type.Integer({ minimum: 100, maximum: 599 }),
    headers: Type.Optional(FixtureHeadersSchema),
    body: Type.Unknown(),
  },
  { additionalProperties: false }
);

const FixtureExpectedErrorSchema = Type.Object(
  {
    phase: stringEnum(["before_dispatch", "after_dispatch"] as const),
    code: Type.String({ pattern: "^[a-z][a-z0-9_]{1,127}$", maxLength: 128 }),
    retryable: Type.Boolean(),
    retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false }
);

const FixtureCaseSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", maxLength: 96 }),
    operationId: Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 }),
    configuration: Type.Optional(
      Type.Record(
        Type.String({ pattern: SLOT_PATTERN, maxLength: 64 }),
        Type.Union([Type.String({ maxLength: 2_048 }), Type.Number(), Type.Boolean()]),
        { additionalProperties: false }
      )
    ),
    request: Type.Record(Type.String({ minLength: 1 }), Type.Unknown(), {
      additionalProperties: false,
    }),
    response: FixtureResponseSchema,
    expect: Type.Union([
      Type.Object(
        {
          request: FixtureRequestShapeSchema,
          result: Type.Unknown(),
        },
        { additionalProperties: false }
      ),
      Type.Object(
        {
          request: FixtureRequestShapeSchema,
          expectedError: FixtureExpectedErrorSchema,
        },
        { additionalProperties: false }
      ),
    ]),
  },
  { additionalProperties: false }
);

/**
 * One offline suite carried by a companion with the OIM `fixture` role.
 *
 * The host sends `request` through the ordinary compiler and adapter into a recording transport,
 * returns `response`, then asserts the declared request shape and result or typed error. The
 * format deliberately has no credential, clock, network, process, or external filesystem
 * capability.
 */
export const OimFixtureSuiteSchema = Type.Object(
  {
    version: Type.Literal(1),
    cases: Type.Array(FixtureCaseSchema, { minItems: 1 }),
  },
  { additionalProperties: false }
);

const FixedTargetFields = {
  baseUrl: Type.String({ pattern: HTTPS_URL_TEMPLATE_PATTERN, maxLength: 2_048 }),
};

const HttpParameterSchema = Type.Object(
  {
    name: Type.String({
      pattern: "^[A-Za-z_][A-Za-z0-9_.-]{0,127}$",
      maxLength: 128,
    }),
    in: stringEnum(["path", "query", "header"] as const),
    required: Type.Optional(Type.Boolean()),
    schema: JsonSchemaObject,
    /**
     * A constant the runtime sends on every call, pinning something an Agent must not choose —
     * a `Notion-Version`, an API revision, a fixed `format=json`.
     *
     * A pinned parameter leaves the Tool schema entirely rather than being marked read-only:
     * a value a model can see is a value it can be talked into overriding, and one it always
     * spends tokens restating. Core 1.1.
     */
    value: Type.Optional(Type.String({ maxLength: 1_024 })),
    configurationField: Type.Optional(Type.String({ pattern: SLOT_PATTERN, maxLength: 64 })),
  },
  { additionalProperties: false }
);

/**
 * How a request body is serialised.
 *
 * Closed to the two encodings the target providers actually require. `form` is
 * `application/x-www-form-urlencoded` and refuses a nested body rather than picking between
 * `a[b]=` and `a.b=`, because providers disagree and a silent choice is wrong for someone.
 * Core 1.1.
 */
const MultipartFieldPartSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$", maxLength: 128 }),
    kind: Type.Literal("field"),
    pointer: Type.String({ pattern: "^(?:/(?:[^/~]|~[01])*)+$", maxLength: 512 }),
    maxBytes: Type.Integer({ minimum: 1, maximum: 1024 * 1024 }),
  },
  { additionalProperties: false }
);

const MultipartFilePartSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$", maxLength: 128 }),
    kind: Type.Literal("file"),
    pointer: Type.String({ pattern: "^(?:/(?:[^/~]|~[01])*)+$", maxLength: 512 }),
  },
  { additionalProperties: false }
);

const MultipartSchema = Type.Object(
  {
    parts: Type.Array(Type.Union([MultipartFieldPartSchema, MultipartFilePartSchema]), {
      minItems: 1,
      maxItems: 16,
    }),
  },
  { additionalProperties: false }
);

const HttpContentTypeSchema = Type.Optional(stringEnum(["json", "form", "multipart"] as const));

const HttpSourceSchema = Type.Object(
  {
    type: Type.Literal("http"),
    method: stringEnum(HTTP_METHODS),
    ...FixedTargetFields,
    path: Type.String({ pattern: "^/(?!/)", maxLength: 2_048 }),
    parameters: Type.Optional(Type.Array(HttpParameterSchema, { maxItems: 64 })),
    contentType: HttpContentTypeSchema,
    multipart: Type.Optional(MultipartSchema),
  },
  { additionalProperties: false }
);

const OpenApiSourceSchema = Type.Object(
  {
    type: Type.Literal("openapi"),
    file: Type.String({ pattern: FILE_PATH_PATTERN }),
    operationId: NonEmptyStringSchema,
    baseUrl: Type.Optional(Type.String({ pattern: HTTPS_URL_PATTERN })),
  },
  { additionalProperties: false }
);

const GraphqlSourceSchema = Type.Object(
  {
    type: Type.Literal("graphql"),
    url: Type.String({ pattern: HTTPS_URL_TEMPLATE_PATTERN, maxLength: 2_048 }),
    operation: NonEmptyStringSchema,
    documentFile: Type.String({ pattern: FILE_PATH_PATTERN }),
  },
  { additionalProperties: false }
);

const CursorPaginationSchema = Type.Object(
  {
    type: Type.Literal("cursor"),
    requestParameter: NonEmptyStringSchema,
    responsePath: Type.String({ pattern: "^/", maxLength: 256 }),
    itemsPath: Type.Optional(Type.String({ pattern: "^/", maxLength: 256 })),
  },
  { additionalProperties: false }
);

const PagePaginationSchema = Type.Object(
  {
    type: Type.Literal("page"),
    requestParameter: NonEmptyStringSchema,
    start: Type.Optional(Type.Integer({ minimum: 0 })),
    itemsPath: Type.Optional(Type.String({ pattern: "^/", maxLength: 256 })),
  },
  { additionalProperties: false }
);

const LinkPaginationSchema = Type.Object(
  {
    type: Type.Literal("link"),
    header: Type.Optional(NonEmptyStringSchema),
    itemsPath: Type.Optional(Type.String({ pattern: "^/", maxLength: 256 })),
  },
  { additionalProperties: false }
);

const ContinuationPaginationSchema = Type.Object(
  {
    type: Type.Literal("continuation"),
    requestParameter: NonEmptyStringSchema,
    responsePath: Type.String({ pattern: "^/", maxLength: 256 }),
    itemsPath: Type.Optional(Type.String({ pattern: "^/", maxLength: 256 })),
  },
  { additionalProperties: false }
);

/**
 * A cursor that travels in the request *body* rather than a query parameter — Notion's
 * `start_cursor`, Jira's `nextPageToken` on its POST search endpoints.
 *
 * The cursor is written by JSON Pointer into the body the Agent supplied, and the pointer's
 * parent must already exist there, so paging can never invent a field the provider will reject.
 * Core 1.1.
 */
const BodyCursorPaginationSchema = Type.Object(
  {
    type: Type.Literal("body_cursor"),
    /** Where the cursor is written in the request body. */
    requestPointer: Type.String({ pattern: "^/", maxLength: 256 }),
    responsePath: Type.String({ pattern: "^/", maxLength: 256 }),
    itemsPath: Type.Optional(Type.String({ pattern: "^/", maxLength: 256 })),
  },
  { additionalProperties: false }
);

const RateLimitSchema = Type.Object(
  {
    requests: Type.Optional(Type.Integer({ minimum: 1 })),
    perSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
    scope: Type.Optional(stringEnum(PAGINATION_SCOPES)),
    remainingHeader: Type.Optional(NonEmptyStringSchema),
    resetHeader: Type.Optional(NonEmptyStringSchema),
    retryAfterHeader: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false }
);

const JsonResponseSchema = Type.Object(
  {
    schema: JsonSchemaObject,
    mode: Type.Optional(Type.Literal("json")),
    projection: Type.Optional(
      Type.Array(Type.String({ pattern: "^/" }), { minItems: 1, uniqueItems: true })
    ),
    maxBytes: Type.Integer({ minimum: 1, maximum: 10 * 1024 * 1024 }),
  },
  { additionalProperties: false }
);

const BinaryResponseSchema = Type.Object(
  {
    mode: Type.Literal("binary"),
    maxBytes: Type.Integer({ minimum: 1, maximum: 10 * 1024 * 1024 }),
  },
  { additionalProperties: false }
);

const ResponseSchema = Type.Union([JsonResponseSchema, BinaryResponseSchema]);

/**
 * How the stored Secret is transformed before it fills `{token}`.
 *
 * `verbatim` is the default and the only safe assumption for an opaque key. `basic` base64-encodes
 * the Secret, which is what an HTTP Basic provider needs — the operator stores `user:password` and
 * never has to run base64 by hand to connect.
 */
const CredentialEncodingSchema = Type.Optional(stringEnum(["verbatim", "basic"] as const));

const CredentialInjectionSchema = Type.Union([
  Type.Object(
    {
      in: Type.Literal("header"),
      name: Type.String({ pattern: "^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$" }),
      format: Type.String({ minLength: 7, maxLength: 256 }),
      encoding: CredentialEncodingSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      in: Type.Literal("query"),
      name: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_.-]{0,127}$" }),
      format: Type.String({ minLength: 7, maxLength: 256 }),
      encoding: CredentialEncodingSchema,
    },
    { additionalProperties: false }
  ),
  /**
   * The credential *is* part of the address — Telegram's `/bot{token}/sendMessage`.
   *
   * It fills a `{credential}` placeholder in `path`, never in `baseUrl`, so a Secret can never
   * move the request to another host. Core 1.1.
   */
  Type.Object(
    {
      in: Type.Literal("path"),
      format: Type.String({ minLength: 7, maxLength: 256 }),
      encoding: CredentialEncodingSchema,
    },
    { additionalProperties: false }
  ),
]);

const SecondaryCredentialSchema = Type.Object(
  {
    slot: Type.String({ pattern: SLOT_PATTERN }),
    injection: CredentialInjectionSchema,
  },
  { additionalProperties: false }
);

const OperationSchema = Type.Object(
  {
    id: Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 }),
    name: Type.String({ pattern: TOOL_NAME_PATTERN }),
    description: NonEmptyStringSchema,
    effect: stringEnum(OIM_EFFECT_CLASSES),
    identityMode: stringEnum(OIM_IDENTITY_MODES),
    credentialSlot: Type.Optional(Type.String({ pattern: SLOT_PATTERN })),
    credentialInjection: Type.Optional(CredentialInjectionSchema),
    secondaryCredential: Type.Optional(SecondaryCredentialSchema),
    source: Type.Union([HttpSourceSchema, OpenApiSourceSchema, GraphqlSourceSchema]),
    requestSchema: Type.Optional(JsonSchemaObject),
    response: ResponseSchema,
    pagination: Type.Optional(
      Type.Union([
        CursorPaginationSchema,
        PagePaginationSchema,
        LinkPaginationSchema,
        ContinuationPaginationSchema,
        BodyCursorPaginationSchema,
      ])
    ),
    rateLimit: Type.Optional(RateLimitSchema),
  },
  { additionalProperties: false }
);

const CredentialSlotSchema = Type.Object(
  {
    id: Type.String({ pattern: SLOT_PATTERN, maxLength: 64 }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    kind: stringEnum(OIM_CREDENTIAL_KINDS),
    required: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

const ConfigurationFieldSchema = Type.Object(
  {
    id: Type.String({ pattern: SLOT_PATTERN, maxLength: 64 }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    type: stringEnum(["string", "url", "boolean", "integer"] as const),
    required: Type.Optional(Type.Boolean()),
    agentVisible: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

const CredentialTargetSchema = Type.Object(
  {
    type: Type.Literal("credential"),
    slot: Type.String({ pattern: SLOT_PATTERN, maxLength: 64 }),
  },
  { additionalProperties: false }
);

const ConfigurationTargetSchema = Type.Object(
  {
    type: Type.Literal("configuration"),
    field: Type.String({ pattern: SLOT_PATTERN, maxLength: 64 }),
  },
  { additionalProperties: false }
);

const AuthFieldSchema = Type.Object(
  {
    id: Type.String({ pattern: SLOT_PATTERN, maxLength: 64 }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    input: stringEnum(["text", "password", "url"] as const),
    target: Type.Union([CredentialTargetSchema, ConfigurationTargetSchema]),
    required: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

const AuthBindingSchema = Type.Object(
  {
    sourcePath: Type.String({ pattern: "^/", maxLength: 512 }),
    target: Type.Union([CredentialTargetSchema, ConfigurationTargetSchema]),
  },
  { additionalProperties: false }
);

const AuthStepBase = {
  id: Type.String({ pattern: SLOT_PATTERN, maxLength: 64 }),
  title: Type.String({ minLength: 1, maxLength: 128 }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
};

const HOST_OWNED_AUTHORIZATION_PARAMETERS = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
]);

const JsonPointerSchema = Type.String({ pattern: "^(?:/(?:[^/~]|~[01])*)+$", maxLength: 512 });
const KnowledgeJsonPointerSchema = Type.String({
  pattern: "^(?:$|/(?:[^/~]|~[01])*(?:/(?:[^/~]|~[01])*)*)$",
  maxLength: 512,
});

const WebhookValueBindingSchema = Type.Union([
  Type.Object(
    { in: Type.Literal("body"), pointer: JsonPointerSchema },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      in: Type.Literal("parameter"),
      name: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_.-]{0,127}$", maxLength: 128 }),
    },
    { additionalProperties: false }
  ),
]);

const AuthStepSchema = Type.Union([
  Type.Object(
    {
      ...AuthStepBase,
      type: Type.Literal("fields"),
      fields: Type.Array(AuthFieldSchema, { minItems: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...AuthStepBase,
      type: Type.Literal("oauth2"),
      authorizationUrl: Type.String({ pattern: HTTPS_URL_PATTERN }),
      tokenUrl: Type.String({ pattern: HTTPS_URL_PATTERN }),
      scopes: Type.Array(NonEmptyStringSchema, { uniqueItems: true }),
      pkce: Type.Optional(Type.Boolean()),
      tokenEndpointAuthMethod: Type.Optional(
        Type.Union([
          Type.Literal("none"),
          Type.Literal("client_secret_post"),
          Type.Literal("client_secret_basic"),
        ])
      ),
      authorizationParameters: Type.Optional(
        Type.Record(
          Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,127}$", maxLength: 128 }),
          Type.String({ minLength: 1, maxLength: 2_048 }),
          { additionalProperties: false }
        )
      ),
      clientId: CredentialTargetSchema,
      clientSecret: Type.Optional(CredentialTargetSchema),
      bindings: Type.Array(AuthBindingSchema, { minItems: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...AuthStepBase,
      type: Type.Literal("app_manifest"),
      createUrl: Type.String({ pattern: HTTPS_URL_PATTERN }),
      manifest: Type.Record(Type.String({ minLength: 1 }), Type.Unknown()),
      bindings: Type.Array(AuthBindingSchema, { minItems: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...AuthStepBase,
      type: Type.Literal("install"),
      url: Type.String({ pattern: HTTPS_URL_PATTERN }),
      bindings: Type.Array(AuthBindingSchema, { minItems: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...AuthStepBase,
      type: Type.Literal("webhook"),
      operationId: Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 }),
      unregisterOperationId: Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 }),
      subscriptionIdPath: JsonPointerSchema,
      secretSlot: Type.String({ pattern: SLOT_PATTERN, maxLength: 64 }),
      registration: Type.Object(
        {
          callbackUrl: WebhookValueBindingSchema,
          secret: Type.Optional(WebhookValueBindingSchema),
        },
        { additionalProperties: false }
      ),
      unregistration: Type.Object(
        { subscriptionId: WebhookValueBindingSchema },
        { additionalProperties: false }
      ),
    },
    { additionalProperties: false }
  ),
]);

const AuthSchema = Type.Object(
  {
    credentialSlots: Type.Array(CredentialSlotSchema, { minItems: 1 }),
    configurationFields: Type.Optional(Type.Array(ConfigurationFieldSchema)),
    steps: Type.Array(AuthStepSchema, { minItems: 1 }),
    healthCheckOperationId: Type.Optional(
      Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 })
    ),
    /**
     * The hosts an installation may resolve a templated `baseUrl` to. Required as soon as any
     * operation uses a placeholder, and checked again at compile time against the resolved host.
     */
    allowedOriginHosts: Type.Optional(
      Type.Array(Type.String({ pattern: ORIGIN_HOST_PATTERN, maxLength: 253 }), {
        minItems: 1,
        uniqueItems: true,
      })
    ),
  },
  { additionalProperties: false }
);

const HookSchema = Type.Object(
  {
    kind: stringEnum(OIM_HOOK_KINDS),
    file: Type.String({ pattern: FILE_PATH_PATTERN }),
    export: Type.String({ pattern: "^[A-Za-z_$][A-Za-z0-9_$]*$" }),
  },
  { additionalProperties: false }
);

const HeaderNameSchema = Type.String({ pattern: "^[A-Za-z0-9!#$%&'*+.^_`|~-]+$", maxLength: 128 });

/**
 * How the runtime proves a delivery came from the provider.
 *
 * `secretSlot` names a Credential slot rather than carrying a value, so the manifest stays
 * publishable and the signing Secret is only ever read by the verification host.
 */
const VerificationSchema = Type.Object(
  {
    scheme: stringEnum(OIM_VERIFICATION_SCHEMES),
    /** The Credential slot holding the shared Secret or public key. */
    secretSlot: Type.String({ pattern: SLOT_PATTERN }),
    signatureHeader: Type.Optional(HeaderNameSchema),
    signatureEncoding: Type.Optional(stringEnum(OIM_SIGNATURE_ENCODINGS)),
    /** Stripped before decoding, e.g. `sha256=`. */
    signaturePrefix: Type.Optional(Type.String({ maxLength: 32 })),
    /**
     * The canonical bytes that were signed, as a template over `{body}` and `{timestamp}`.
     * Defaults to `{body}`. Anything not named here is not covered by the signature.
     */
    signingInput: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    timestampHeader: Type.Optional(HeaderNameSchema),
    /** How far out of date a delivery may be. Bounded so a manifest cannot disable replay defence. */
    toleranceSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
    issuer: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    audience: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false }
);

const HandshakeSchema = Type.Object(
  {
    kind: stringEnum(OIM_HANDSHAKE_KINDS),
    /** Where the challenge value is read from, for the kind that needs one. */
    bodyPointer: Type.Optional(JsonPointerSchema),
    header: Type.Optional(HeaderNameSchema),
    /** The field the runtime echoes it back in. Absent means a bare body. */
    responseField: Type.Optional(Type.String({ pattern: SLOT_PATTERN })),
  },
  { additionalProperties: false }
);

/**
 * What the Integration is willing to receive.
 *
 * Declared so unrelated provider traffic is discarded before it is trusted, rather than being
 * normalized into an event nothing subscribes to and left in the inbox as noise.
 */
const AcceptanceSchema = Type.Object(
  {
    requireBodyPointers: Type.Optional(Type.Array(JsonPointerSchema, { uniqueItems: true })),
    /** Discard anything whose selector matches nothing in `eventTypes`. Defaults to true. */
    requireKnownEventType: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

const DeduplicationSchema = Type.Object(
  {
    kind: stringEnum(OIM_DEDUPLICATION_KINDS),
    header: Type.Optional(HeaderNameSchema),
    bodyPointer: Type.Optional(JsonPointerSchema),
  },
  { additionalProperties: false }
);

const EventTypeSchema = Type.Object(
  {
    type: Type.String({ pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$", maxLength: 128 }),
    /** Picks this type out of a delivery. First match wins, in declaration order. */
    selector: Type.Object(
      {
        pointer: JsonPointerSchema,
        equals: Type.Optional(Type.String({ maxLength: 256 })),
        matches: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      },
      { additionalProperties: false }
    ),
    /** The contract a subscribed Routine is written against. */
    schema: JsonSchemaObject,
    /** The `response_normalize` hook export that shapes the payload. Absent passes it through. */
    normalize: Type.Optional(Type.String({ pattern: "^[A-Za-z_$][A-Za-z0-9_$]*$" })),
    /** Headers a hook may read. Everything else is withheld, signatures included. */
    safeHeaders: Type.Optional(Type.Array(HeaderNameSchema, { uniqueItems: true })),
  },
  { additionalProperties: false }
);

const EventsSchema = Type.Object(
  {
    /** Appended to the deployment's ingress base; never a full URL an author could retarget. */
    path: Type.String({ pattern: "^/[A-Za-z0-9][A-Za-z0-9._/-]*$", maxLength: 128 }),
    verification: VerificationSchema,
    handshake: Type.Optional(HandshakeSchema),
    acceptance: Type.Optional(AcceptanceSchema),
    deduplication: DeduplicationSchema,
    eventTypes: Type.Array(EventTypeSchema, { minItems: 1 }),
    /** How long the encrypted raw body is kept. Defaults to seven days. */
    rawRetentionDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
  },
  { additionalProperties: false }
);

/**
 * A pull-based ingress for providers that cannot deliver webhooks.
 *
 * The default cursor is opaque to the runtime. Batched integer event streams may instead advance
 * to one past the largest declared item id. Either value is returned to the same operation only
 * after the response that produced it has been made durable.
 */
const PollingCursorSchema = Type.Union([
  Type.Object(
    {
      responsePointer: JsonPointerSchema,
      requestParameter: NonEmptyStringSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      mode: Type.Literal("max_integer_plus_one"),
      /** Selects the response array whose item ids advance the cursor. */
      responsePointer: JsonPointerSchema,
      /** Selects one non-negative safe integer id within each response item. */
      itemPointer: JsonPointerSchema,
      requestParameter: NonEmptyStringSchema,
    },
    { additionalProperties: false }
  ),
]);

const PollingIngressSchema = Type.Object(
  {
    kind: Type.Literal("polling"),
    operationId: Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 }),
    /** A provider-safe floor. The scheduler never polls more often than this. */
    intervalSeconds: Type.Integer({ minimum: 60, maximum: 86_400 }),
    /** Typed events selected from each durably persisted response item. */
    eventTypes: Type.Optional(Type.Array(EventTypeSchema, { minItems: 1 })),
    cursor: PollingCursorSchema,
  },
  { additionalProperties: false }
);

/**
 * How an indexed item's readers are established.
 *
 * `item` asks the provider per item; `scope` captures one ACL for the whole selected scope, for
 * providers that only express permissions at container level. There is deliberately no third
 * option meaning "no ACL": a provider that expresses permissions and an index that ignores them
 * is how a search result widens access, and the profile refuses to describe it.
 */
export const OIM_KNOWLEDGE_ACL_MODES = ["item", "scope"] as const;

/** What an ACL entry grants access to. `public` means everyone the provider can see. */
export const OIM_KNOWLEDGE_PRINCIPAL_KINDS = ["user", "group", "domain", "public"] as const;

/**
 * How a source deletion becomes a Knowledge deletion.
 *
 * `none` has to be spelled out, exactly as event deduplication does. An author who omits deletion
 * has not decided that content never disappears — they have not thought about it, and the
 * difference is whether a removed document stays searchable forever.
 */
export const OIM_KNOWLEDGE_DELETION_KINDS = [
  "list_flag",
  "absent_from_full_list",
  "operation",
  "none",
] as const;

/** Where a page cursor is read from between Runs. */
export const OIM_KNOWLEDGE_CURSOR_KINDS = [
  "operation_pagination",
  "response_pointer",
  "none",
] as const;

const KnowledgeSourceKindSchema = Type.Object(
  {
    id: Type.String({ pattern: SLOT_PATTERN, maxLength: 64 }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    /** Lists the scopes a user may pick from, so an Agent offers choices instead of inventing them. */
    discoverOperationId: Type.Optional(
      Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 })
    ),
    discoverItemsPointer: Type.Optional(KnowledgeJsonPointerSchema),
    discoverMapping: Type.Optional(
      Type.Object(
        { id: KnowledgeJsonPointerSchema, label: KnowledgeJsonPointerSchema },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

const KnowledgeListMappingSchema = Type.Object(
  {
    /** Stable across revisions and renames; a mapping onto a mutable field breaks incremental sync. */
    itemId: Type.Optional(KnowledgeJsonPointerSchema),
    itemFields: Type.Optional(
      Type.Record(
        Type.String({ pattern: SLOT_PATTERN, maxLength: 64 }),
        Type.Union([
          Type.Object({ source: Type.Literal("scope") }, { additionalProperties: false }),
          Type.Object(
            { source: Type.Literal("item"), pointer: KnowledgeJsonPointerSchema },
            { additionalProperties: false }
          ),
        ]),
        { additionalProperties: false }
      )
    ),
    /** Ordered fields whose typed values form the stable, collision-safe item identity. */
    itemIdentity: Type.Optional(
      Type.Array(Type.String({ pattern: SLOT_PATTERN, maxLength: 64 }), {
        minItems: 1,
        uniqueItems: true,
      })
    ),
    revision: Type.Optional(KnowledgeJsonPointerSchema),
    title: Type.Optional(KnowledgeJsonPointerSchema),
    sourceUrl: Type.Optional(KnowledgeJsonPointerSchema),
    updatedAt: Type.Optional(KnowledgeJsonPointerSchema),
    contentType: Type.Optional(KnowledgeJsonPointerSchema),
    /** Truthy here means the provider is reporting the item as removed. */
    deleted: Type.Optional(KnowledgeJsonPointerSchema),
  },
  { additionalProperties: false }
);

const KnowledgeParameterBindingsSchema = Type.Record(
  Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_.-]{0,127}$", maxLength: 128 }),
  Type.String({ pattern: SLOT_PATTERN, maxLength: 64 }),
  { additionalProperties: false }
);

const KnowledgeContentValueSchema = Type.Union([
  KnowledgeJsonPointerSchema,
  Type.Object(
    {
      itemsPointer: KnowledgeJsonPointerSchema,
      itemPointer: KnowledgeJsonPointerSchema,
      separator: Type.String({ maxLength: 64 }),
    },
    { additionalProperties: false }
  ),
]);

const KnowledgeCursorSchema = Type.Object(
  {
    kind: stringEnum(OIM_KNOWLEDGE_CURSOR_KINDS),
    /** For `response_pointer`: the watermark to resume from on the next Run. */
    pointer: Type.Optional(JsonPointerSchema),
    /** The request parameter the saved watermark is fed back into. */
    requestParameter: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false }
);

const KnowledgeListSchema = Type.Object(
  {
    operationId: Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 }),
    /** The request parameter carrying the user's selected scope. */
    scopeParameter: Type.Optional(NonEmptyStringSchema),
    itemsPointer: KnowledgeJsonPointerSchema,
    mapping: KnowledgeListMappingSchema,
    cursor: KnowledgeCursorSchema,
    /** Bounds one Run's walk so a large source cannot hold a Routine open indefinitely. */
    maxPagesPerRun: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
  },
  { additionalProperties: false }
);

const KnowledgeContentSchema = Type.Object(
  {
    operationId: Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 }),
    /** The request parameter carrying the item id from the list step. */
    itemParameter: Type.Optional(NonEmptyStringSchema),
    /** Operation parameter to named, host-projected item field. Knowledge 1.1. */
    parameters: Type.Optional(KnowledgeParameterBindingsSchema),
    mapping: Type.Object(
      {
        content: KnowledgeContentValueSchema,
        contentType: Type.Optional(KnowledgeJsonPointerSchema),
        revision: Type.Optional(KnowledgeJsonPointerSchema),
        title: Type.Optional(KnowledgeJsonPointerSchema),
        sourceUrl: Type.Optional(KnowledgeJsonPointerSchema),
        updatedAt: Type.Optional(KnowledgeJsonPointerSchema),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

/**
 * How one provider ACL entry is read.
 *
 * There is no display-name pointer on purpose. A display name is chosen by the account it names,
 * so matching on one lets anyone who can rename themselves inherit somebody else's access.
 */
const KnowledgeAclEntrySchema = Type.Object(
  {
    kindPointer: Type.Optional(KnowledgeJsonPointerSchema),
    /** Which provider values mean which principal kind. Absent kinds cannot appear. */
    kindValues: Type.Optional(
      Type.Object(
        {
          user: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { uniqueItems: true })),
          group: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { uniqueItems: true })),
          domain: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { uniqueItems: true })),
          public: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { uniqueItems: true })),
        },
        { additionalProperties: false }
      )
    ),
    /** Used when every entry is the same kind and the provider says nothing about it. */
    defaultKind: Type.Optional(stringEnum(OIM_KNOWLEDGE_PRINCIPAL_KINDS)),
    providerUserId: Type.Optional(KnowledgeJsonPointerSchema),
    providerGroupId: Type.Optional(KnowledgeJsonPointerSchema),
    domain: Type.Optional(KnowledgeJsonPointerSchema),
  },
  { additionalProperties: false }
);

const KnowledgeAclSchema = Type.Union([
  Type.Object(
    {
      mode: Type.Literal("item"),
      operationId: Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 }),
      itemParameter: Type.Optional(NonEmptyStringSchema),
      parameters: Type.Optional(KnowledgeParameterBindingsSchema),
      entriesPointer: KnowledgeJsonPointerSchema,
      entry: KnowledgeAclEntrySchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      mode: Type.Literal("scope"),
      operationId: Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 }),
      scopeParameter: NonEmptyStringSchema,
      entriesPointer: KnowledgeJsonPointerSchema,
      entry: KnowledgeAclEntrySchema,
    },
    { additionalProperties: false }
  ),
]);

const KnowledgeIdentityLookupSchema = Type.Object(
  {
    operationId: Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 }),
    idParameter: NonEmptyStringSchema,
    mapping: Type.Object(
      {
        /** The provider's own stable handle; an email or a name is not one. */
        providerId: KnowledgeJsonPointerSchema,
        email: Type.Optional(KnowledgeJsonPointerSchema),
        /** Only a provider that says an address is verified may have it used for matching. */
        emailVerified: Type.Optional(KnowledgeJsonPointerSchema),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

const KnowledgeIdentitySchema = Type.Object(
  {
    user: Type.Optional(KnowledgeIdentityLookupSchema),
    group: Type.Optional(
      Type.Object(
        {
          operationId: Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 }),
          idParameter: NonEmptyStringSchema,
          membersPointer: Type.Optional(KnowledgeJsonPointerSchema),
          mapping: Type.Object(
            {
              providerId: KnowledgeJsonPointerSchema,
              memberUserId: Type.Optional(KnowledgeJsonPointerSchema),
            },
            { additionalProperties: false }
          ),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

const KnowledgeDeletionSchema = Type.Object(
  {
    kind: stringEnum(OIM_KNOWLEDGE_DELETION_KINDS),
    operationId: Type.Optional(Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 })),
    scopeParameter: Type.Optional(NonEmptyStringSchema),
    parameters: Type.Optional(KnowledgeParameterBindingsSchema),
    itemsPointer: Type.Optional(KnowledgeJsonPointerSchema),
    itemIdPointer: Type.Optional(KnowledgeJsonPointerSchema),
  },
  { additionalProperties: false }
);

/**
 * What an Integration teaches TulipFarm about indexing a provider.
 *
 * It describes; it never runs. Installing an Integration that declares this block starts no
 * indexing — a user asks in Chat, and a platform Agent authors an ordinary Routine from exactly
 * these roles. That is why every field here names an operation the Core profile already declares
 * rather than introducing a second way to reach the network.
 */
const KnowledgeSchema = Type.Object(
  {
    sourceKinds: Type.Array(KnowledgeSourceKindSchema, { minItems: 1 }),
    list: KnowledgeListSchema,
    content: KnowledgeContentSchema,
    acl: KnowledgeAclSchema,
    identity: Type.Optional(KnowledgeIdentitySchema),
    deletion: KnowledgeDeletionSchema,
    /**
     * Provider-specific sequencing, scope advice, cost and limitations, for the Agent to read.
     * Formal roles say what is possible; this says what is wise.
     */
    guideFile: Type.Optional(Type.String({ pattern: FILE_PATH_PATTERN })),
    /** Live re-authorization before returning a result, for providers that support it. */
    liveAuthorization: Type.Optional(
      Type.Object(
        {
          operationId: Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 }),
          itemParameter: Type.Optional(NonEmptyStringSchema),
          parameters: Type.Optional(KnowledgeParameterBindingsSchema),
          principalParameter: Type.Optional(NonEmptyStringSchema),
          allowedPointer: Type.Optional(KnowledgeJsonPointerSchema),
          principalSet: Type.Optional(
            Type.Object(
              {
                entriesPointer: KnowledgeJsonPointerSchema,
                principalIdPointer: KnowledgeJsonPointerSchema,
              },
              { additionalProperties: false }
            )
          ),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

export const OimManifestSchema = Type.Object(
  {
    oimVersion: Type.Literal(OIM_VERSION),
    kind: Type.Literal("Integration"),
    metadata: MetadataSchema,
    profiles: ProfilesSchema,
    files: Type.Optional(Type.Array(CompanionFileSchema, { uniqueItems: true })),
    auth: Type.Optional(AuthSchema),
    operations: Type.Array(OperationSchema, { minItems: 1 }),
    events: Type.Optional(EventsSchema),
    ingress: Type.Optional(PollingIngressSchema),
    knowledge: Type.Optional(KnowledgeSchema),
    hooks: Type.Optional(Type.Array(HookSchema, { minItems: 1 })),
    extensions: Type.Optional(
      Type.Unsafe<Record<string, unknown>>({
        type: "object",
        propertyNames: { pattern: "^x-[a-z][a-z0-9-]*$" },
        additionalProperties: true,
      })
    ),
  },
  { additionalProperties: false }
);

const ConnectionOwnerSchema = Type.Union([
  Type.Object(
    {
      scope: Type.Literal("personal"),
      principalKind: Type.Literal("user"),
      principalId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      scope: Type.Literal("organization"),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      scope: Type.Literal("team"),
      teamId: TeamIdSchema,
    },
    { additionalProperties: false }
  ),
]);

const ConnectionConfigurationSchema = Type.Unsafe<Record<string, string | number | boolean>>({
  type: "object",
  propertyNames: { pattern: SLOT_PATTERN },
  additionalProperties: {
    anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
  },
});

const SecretBindingsSchema = Type.Unsafe<Record<string, string>>({
  type: "object",
  propertyNames: { pattern: SLOT_PATTERN },
  additionalProperties: {
    type: "string",
    pattern: OPAQUE_SECRET_REFERENCE_PATTERN,
    maxLength: 265,
  },
});

const WebhookRegistrationSchema = Type.Object(
  {
    ingressUrl: Type.String({ pattern: HTTPS_URL_PATTERN, maxLength: 2_048 }),
    subscriptionId: Type.String({ minLength: 1, maxLength: 1_024 }),
    operationId: Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 }),
    unregisterOperationId: Type.String({ pattern: OPERATION_ID_PATTERN, maxLength: 96 }),
    secretSlot: Type.String({ pattern: SLOT_PATTERN, maxLength: 64 }),
  },
  { additionalProperties: false }
);

export const OimConnectionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    integration: Type.Object(
      {
        id: Type.String({ pattern: SLUG_PATTERN, maxLength: 96 }),
        majorVersion: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false }
    ),
    label: Type.String({ minLength: 1, maxLength: 128 }),
    owner: ConnectionOwnerSchema,
    status: stringEnum(["active", "revoked"] as const),
    isDefault: Type.Boolean(),
    configuration: ConnectionConfigurationSchema,
    agentVisibleConfiguration: Type.Array(Type.String({ pattern: SLOT_PATTERN }), {
      uniqueItems: true,
    }),
    secretBindings: SecretBindingsSchema,
    health: Type.Object(
      {
        status: stringEnum(OIM_CONNECTION_HEALTH_STATES),
        checkedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
      },
      { additionalProperties: false }
    ),
    expiresAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    webhookRegistration: Type.Optional(WebhookRegistrationSchema),
  },
  { additionalProperties: false }
);

export const OimConformanceClaimSchema = Type.Object(
  {
    oimVersion: Type.Literal(OIM_VERSION),
    runtime: Type.Object(
      {
        name: NonEmptyStringSchema,
        version: NonEmptyStringSchema,
      },
      { additionalProperties: false }
    ),
    profiles: ProfilesSchema,
    passedCases: Type.Array(Type.String({ pattern: "^[a-z]+(?:[.-][a-z0-9]+)+$" }), {
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

export type OimManifest = Static<typeof OimManifestSchema>;
export type OimOperation = Static<typeof OperationSchema>;
export type OimPagination = NonNullable<OimOperation["pagination"]>;
export type OimMultipartPart = Static<
  typeof MultipartFieldPartSchema | typeof MultipartFilePartSchema
>;
export type OimAuth = Static<typeof AuthSchema>;
export type OimConnection = Static<typeof OimConnectionSchema>;
export type OimCompanionFile = Static<typeof CompanionFileSchema>;
export type OimFixtureSuite = Static<typeof OimFixtureSuiteSchema>;
export type OimFixtureCase = Static<typeof FixtureCaseSchema>;
export type OimHook = Static<typeof HookSchema>;
export type OimEvents = Static<typeof EventsSchema>;
export type OimPollingIngress = Static<typeof PollingIngressSchema>;
export type OimVerification = Static<typeof VerificationSchema>;
export type OimEventType = Static<typeof EventTypeSchema>;
export type OimDeduplication = Static<typeof DeduplicationSchema>;
export type OimHandshake = Static<typeof HandshakeSchema>;
export type OimKnowledge = Static<typeof KnowledgeSchema>;
export type OimKnowledgeSourceKind = Static<typeof KnowledgeSourceKindSchema>;
export type OimKnowledgeList = Static<typeof KnowledgeListSchema>;
export type OimKnowledgeContent = Static<typeof KnowledgeContentSchema>;
export type OimKnowledgeAcl = Static<typeof KnowledgeAclSchema>;
export type OimKnowledgeAclEntry = Static<typeof KnowledgeAclEntrySchema>;
export type OimKnowledgeIdentity = Static<typeof KnowledgeIdentitySchema>;
export type OimKnowledgeDeletion = Static<typeof KnowledgeDeletionSchema>;
export type OimKnowledgePrincipalKind = (typeof OIM_KNOWLEDGE_PRINCIPAL_KINDS)[number];
export type OimPackageContent = string | Uint8Array;
export type OimConformanceClaim = Static<typeof OimConformanceClaimSchema>;

const check = ajv.compile(OimManifestSchema);
const fixtureSuiteCheck = ajv.compile(OimFixtureSuiteSchema);
const connectionCheck = ajv.compile(OimConnectionSchema);
const conformanceCheck = ajv.compile(OimConformanceClaimSchema);

const PROHIBITED_FILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "cargo.toml",
  "composer.json",
  "composer.lock",
  "deno.json",
  "deno.lock",
  "gemfile",
  "gemfile.lock",
  "go.mod",
  "go.sum",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "pipfile",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "yarn.lock",
]);

const PROHIBITED_EXTENSIONS = [
  ".7z",
  ".bin",
  ".bz2",
  ".dll",
  ".dylib",
  ".exe",
  ".gz",
  ".node",
  ".rar",
  ".so",
  ".tar",
  ".tgz",
  ".wasm",
  ".xz",
  ".zip",
];

const BINARY_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x1f, 0x8b],
  [0x89, 0x50, 0x4e, 0x47],
  [0xff, 0xd8, 0xff],
  [0x7f, 0x45, 0x4c, 0x46],
  [0x00, 0x61, 0x73, 0x6d],
] as const;

const ROLE_EXTENSIONS: Readonly<Record<OimCompanionFile["role"], readonly string[]>> = {
  openapi: [".json", ".yaml", ".yml"],
  graphql: [".gql", ".graphql"],
  guide: [".md"],
  hook: [".js", ".mjs"],
  fixture: [".json", ".txt", ".yaml", ".yml"],
};

function companionByPath(manifest: OimManifest): Map<string, OimCompanionFile> {
  return new Map((manifest.files ?? []).map((file) => [file.path, file]));
}

function extension(path: string): string {
  const fileName = path.split("/").at(-1) ?? path;
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
}

function prohibitedFileIssue(path: string): string | undefined {
  const fileName = path.split("/").at(-1)?.toLowerCase() ?? path.toLowerCase();
  if (path.toLowerCase() === "oim.yml") {
    return `${path} is the OIM entry point and cannot be a companion file`;
  }
  if (path.toLowerCase() === "manifest.yml") return `${path} is not allowed in an OIM package`;
  if (PROHIBITED_FILE_NAMES.has(fileName)) return `${path} is not allowed in an OIM package`;
  if (/^(?:preinstall|install|postinstall)\.(?:c?js|mjs|sh)$/.test(fileName)) {
    return `${path} is not allowed in an OIM package`;
  }
  if (PROHIBITED_EXTENSIONS.some((suffix) => fileName.endsWith(suffix))) {
    return `${path} is not allowed in an OIM package`;
  }
  return undefined;
}

function validHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function publicHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized === "home.arpa" ||
    normalized.endsWith(".home.arpa")
  ) {
    return false;
  }

  const addressType = isIP(normalized);
  if (addressType === 0) return normalized.includes(".");
  if (addressType === 6) {
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      /^f[cd]/.test(normalized) ||
      /^fe[89ab]/.test(normalized) ||
      /^fe[c-f]/.test(normalized) ||
      normalized.startsWith("2001:db8") ||
      normalized.startsWith("::ffff:")
    );
  }

  const octets = normalized.split(".").map(Number);
  const [first = 0, second = 0] = octets;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && octets[2] === 100) ||
    (first === 203 && second === 0 && octets[2] === 113) ||
    first >= 224
  );
}

function publicHttpsUrl(value: string): URL | undefined {
  const url = validHttpsUrl(value);
  return url && publicHostname(url.hostname) ? url : undefined;
}

function embeddedSchemaIssue(schema: Record<string, unknown>): string | undefined {
  try {
    if (!ajv.validateSchema(schema)) return "is invalid";
    const candidate = structuredClone(schema);
    delete candidate.$id;
    ajv.compile(candidate);
    return undefined;
  } catch {
    return "is invalid";
  }
}

function beginsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function packageContentIssue(
  file: OimCompanionFile,
  content: OimPackageContent
): string | undefined {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  if (bytes.includes(0) || BINARY_SIGNATURES.some((signature) => beginsWith(bytes, signature))) {
    return `${file.path} must contain UTF-8 text, not binary data`;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return `${file.path} must contain UTF-8 text, not binary data`;
  }
  if (
    [...text].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13;
    })
  ) {
    return `${file.path} must contain UTF-8 text, not binary data`;
  }

  const fileExtension = extension(file.path);
  try {
    if (fileExtension === ".json") JSON.parse(text);
    if (fileExtension === ".yaml" || fileExtension === ".yml") parseYaml(text);
  } catch {
    return `${file.path} does not contain valid ${fileExtension.slice(1).toUpperCase()}`;
  }
  return undefined;
}

function packageText(content: OimPackageContent): string | undefined {
  try {
    return typeof content === "string"
      ? content
      : new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

function documentContent(content: OimPackageContent): unknown {
  const text = packageText(content);
  if (!text) return undefined;
  return text.trimStart().startsWith("{") ? JSON.parse(text) : parseYaml(text);
}

function publicOpenApiServers(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((server) => {
      const url = record(server)?.url;
      return typeof url === "string" && !url.includes("{") && publicHttpsUrl(url) !== undefined;
    })
  );
}

function openApiOperationIssues(
  content: OimPackageContent,
  operationId: string,
  hasBaseUrlOverride: boolean
): string[] {
  let document: Record<string, unknown> | undefined;
  try {
    document = record(documentContent(content));
  } catch {
    return [];
  }
  if (
    !document ||
    typeof document.openapi !== "string" ||
    !document.openapi.startsWith("3.") ||
    !record(document.paths)
  ) {
    return ["OpenAPI document is not a valid OpenAPI 3.x contract"];
  }

  const matches: Array<{
    operation: Record<string, unknown>;
    pathItem: Record<string, unknown>;
  }> = [];
  for (const pathItemValue of Object.values(record(document.paths) ?? {})) {
    const pathItem = record(pathItemValue);
    if (!pathItem) continue;
    for (const method of ["get", "put", "post", "delete", "options", "head", "patch", "trace"]) {
      const operation = record(pathItem[method]);
      if (operation?.operationId === operationId) matches.push({ operation, pathItem });
    }
  }
  if (matches.length !== 1) {
    return [`OpenAPI document must define operationId ${operationId} exactly once`];
  }
  if (hasBaseUrlOverride) return [];

  const [{ operation, pathItem }] = matches;
  const servers = operation.servers ?? pathItem.servers ?? document.servers;
  return publicOpenApiServers(servers)
    ? []
    : ["OpenAPI operation must resolve only to public HTTPS servers"];
}

/**
 * Which GraphQL operation kind a document declares under `operationName`, or `undefined` when the
 * document does not define it exactly once.
 *
 * A manifest states an operation's effect and its document states a kind, and those are two claims
 * by the same author that can disagree. A compiler reads the kind from here so it can refuse a
 * package whose `read` operation is really a mutation.
 */
export function oimGraphqlOperationKind(
  document: string,
  operationName: string
): "query" | "mutation" | "subscription" | undefined {
  let parsed: DocumentNode;
  try {
    parsed = parseGraphql(document, { noLocation: true });
  } catch {
    return undefined;
  }
  const matches = parsed.definitions.filter(
    (definition) =>
      definition.kind === Kind.OPERATION_DEFINITION && definition.name?.value === operationName
  );
  const [only] = matches;
  if (matches.length !== 1 || only?.kind !== Kind.OPERATION_DEFINITION) return undefined;
  return only.operation;
}

function graphqlOperationIssue(
  content: OimPackageContent,
  operationName: string
): string | undefined {
  const text = packageText(content);
  if (!text) return "GraphQL document is not valid UTF-8";
  try {
    const document = parseGraphql(text, { noLocation: true });
    const matches = document.definitions.filter(
      (definition) =>
        definition.kind === Kind.OPERATION_DEFINITION && definition.name?.value === operationName
    );
    if (matches.length !== 1) {
      return `GraphQL document must define operation ${operationName} exactly once`;
    }
  } catch {
    return "GraphQL document is invalid";
  }
  return undefined;
}

/** Structural validation for the portable OIM contract. */
export function validateOimManifest(data: unknown): OimManifest {
  if (!check(data)) {
    const failure = check.errors?.[0];
    throw new TulipFarmValidationError(
      "integration",
      failure?.instancePath ?? "",
      failure?.message ?? "invalid OIM manifest"
    );
  }
  return data as OimManifest;
}

/** Structural validation for an offline fixture suite companion. */
export function validateOimFixtureSuite(data: unknown): OimFixtureSuite {
  if (!fixtureSuiteCheck(data)) {
    const failure = fixtureSuiteCheck.errors?.[0];
    throw new TulipFarmValidationError(
      "integration",
      failure?.instancePath ?? "",
      failure?.message ?? "invalid OIM fixture suite"
    );
  }
  return data as OimFixtureSuite;
}

/** Structural validation for a host-persisted Connection. Secret values are never accepted. */
export function validateOimConnection(data: unknown): OimConnection {
  if (!connectionCheck(data)) {
    const failure = connectionCheck.errors?.[0];
    throw new TulipFarmValidationError(
      "integration",
      failure?.instancePath ?? "",
      failure?.message ?? "invalid OIM Connection"
    );
  }
  return data as OimConnection;
}

/** Structural validation for an OIM runtime conformance claim. */
export function validateOimConformanceClaim(data: unknown): OimConformanceClaim {
  if (!conformanceCheck(data)) {
    const failure = conformanceCheck.errors?.[0];
    throw new TulipFarmValidationError(
      "integration",
      failure?.instancePath ?? "",
      failure?.message ?? "invalid OIM conformance claim"
    );
  }
  return data as OimConformanceClaim;
}

const ORIGIN_PLACEHOLDER = /\{([a-z][a-z0-9_]{1,63})\}/g;

/** The configuration field a templated base URL defers to, or `undefined` for a fixed one. */
export function oimOriginPlaceholder(baseUrl: string): string | undefined {
  const matches = [...baseUrl.matchAll(ORIGIN_PLACEHOLDER)];
  return matches.length === 0 ? undefined : matches[0][1];
}

/** True when `host` is covered by one of the manifest's declared origin patterns. */
export function oimOriginAllowed(host: string, patterns: readonly string[]): boolean {
  const target = host.toLowerCase();
  return patterns.some((pattern) => {
    const lower = pattern.toLowerCase();
    if (!lower.startsWith("*.")) return lower === target;
    const suffix = lower.slice(1);
    // A wildcard covers subdomains, never the bare parent: `*.example.com` must not match
    // `example.com`, or a package promising customer sites could reach the vendor's own.
    return target.endsWith(suffix) && target.length > suffix.length;
  });
}

/** Cross-field OIM rules that JSON Schema cannot express. */
export function oimManifestIssues(manifest: OimManifest): string[] {
  const issues: string[] = [];
  const files = companionByPath(manifest);
  const seenFilePaths = new Set<string>();

  for (const file of manifest.files ?? []) {
    if (seenFilePaths.has(file.path)) issues.push(`files: ${file.path} is declared more than once`);
    seenFilePaths.add(file.path);

    const prohibited = prohibitedFileIssue(file.path);
    if (prohibited) issues.push(`files: ${prohibited}`);

    const allowed = ROLE_EXTENSIONS[file.role];
    const actualExtension = extension(file.path);
    if (!allowed.includes(actualExtension)) {
      issues.push(
        `files: ${file.path} has role ${file.role}, which requires ${allowed.join(" or ")}`
      );
    }
  }

  const operationIds = new Set<string>();
  const operationNames = new Set<string>();
  const credentialSlots = new Set<string>();
  const configurationFields = new Map<string, boolean>();
  if (manifest.auth) {
    if (manifest.profiles.auth !== OIM_PROFILE_VERSIONS.auth) {
      issues.push('profiles: auth "1.0" is required when auth is declared');
    }
    for (const slot of manifest.auth.credentialSlots) {
      if (credentialSlots.has(slot.id)) {
        issues.push(`auth: credential slot ${slot.id} is declared more than once`);
      }
      credentialSlots.add(slot.id);
    }
    for (const field of manifest.auth.configurationFields ?? []) {
      if (configurationFields.has(field.id)) {
        issues.push(`auth: configuration field ${field.id} is declared more than once`);
      }
      configurationFields.set(field.id, field.agentVisible === true);
    }
    const stepIds = new Set<string>();
    for (const step of manifest.auth.steps) {
      if (stepIds.has(step.id)) issues.push(`auth: step ${step.id} is declared more than once`);
      stepIds.add(step.id);
      const targets =
        step.type === "fields"
          ? step.fields.map((field) => field.target)
          : step.type === "oauth2" || step.type === "app_manifest" || step.type === "install"
            ? [
                ...(step.type === "oauth2"
                  ? [step.clientId, ...(step.clientSecret ? [step.clientSecret] : [])]
                  : []),
                ...step.bindings.map((binding) => binding.target),
              ]
            : [];
      for (const target of targets) {
        if (target.type === "credential" && !credentialSlots.has(target.slot)) {
          issues.push(`auth: step ${step.id} references undeclared credential slot ${target.slot}`);
        }
        if (target.type === "configuration" && !configurationFields.has(target.field)) {
          issues.push(
            `auth: step ${step.id} references undeclared configuration field ${target.field}`
          );
        }
      }
      if (step.type === "fields") {
        for (const field of step.fields) {
          if (field.input === "password" && field.target.type !== "credential") {
            issues.push(
              `auth: step ${step.id} password field ${field.id} must target a credential slot`
            );
          }
        }
      }
      if (step.type === "webhook" && step.secretSlot && !credentialSlots.has(step.secretSlot)) {
        issues.push(
          `auth: step ${step.id} references undeclared credential slot ${step.secretSlot}`
        );
      }
      if (step.type === "oauth2") {
        const tokenEndpointAuthMethod =
          step.tokenEndpointAuthMethod ??
          (step.clientSecret === undefined ? "none" : "client_secret_post");
        if (tokenEndpointAuthMethod !== "none" && step.clientSecret === undefined) {
          issues.push(
            `auth: step ${step.id} tokenEndpointAuthMethod ${tokenEndpointAuthMethod} requires clientSecret`
          );
        }
        if (tokenEndpointAuthMethod === "none" && step.clientSecret !== undefined) {
          issues.push(
            `auth: step ${step.id} tokenEndpointAuthMethod none cannot declare clientSecret`
          );
        }
        if (tokenEndpointAuthMethod === "none" && step.pkce === false) {
          issues.push(`auth: step ${step.id} public OAuth client requires PKCE`);
        }
        for (const parameter of Object.keys(step.authorizationParameters ?? {})) {
          if (HOST_OWNED_AUTHORIZATION_PARAMETERS.has(parameter)) {
            issues.push(
              `auth: step ${step.id} authorizationParameters cannot set host-owned ${parameter}`
            );
          }
        }
      }
      for (const url of [
        ...(step.type === "oauth2" ? [step.authorizationUrl, step.tokenUrl] : []),
        ...(step.type === "app_manifest" ? [step.createUrl] : []),
        ...(step.type === "install" ? [step.url] : []),
      ]) {
        if (!publicHttpsUrl(url)) {
          issues.push(`auth: step ${step.id} URL must use a public HTTPS origin`);
        }
      }
    }
  } else if (manifest.profiles.auth !== undefined) {
    issues.push("auth: declaration is required when the Auth profile is claimed");
  }

  for (const operation of manifest.operations) {
    if (operationIds.has(operation.id)) {
      issues.push(`operations: ${operation.id} is declared more than once`);
    }
    operationIds.add(operation.id);

    if (operationNames.has(operation.name)) {
      issues.push(`operations: Tool name ${operation.name} is declared more than once`);
    }
    operationNames.add(operation.name);
    if (oimToolId(manifest, operation.id).length > 256) {
      issues.push(`operations: ${operation.id} derives a Tool id longer than 256 characters`);
    }

    if (operation.requestSchema) {
      const issue = embeddedSchemaIssue(operation.requestSchema);
      if (issue) issues.push(`operations: ${operation.id} request schema ${issue}`);
    }
    if (operation.credentialSlot && !credentialSlots.has(operation.credentialSlot)) {
      issues.push(
        `operations: ${operation.id} references undeclared credential slot ${operation.credentialSlot}`
      );
    }
    if (operation.secondaryCredential && !credentialSlots.has(operation.secondaryCredential.slot)) {
      issues.push(
        `operations: ${operation.id} references undeclared credential slot ${operation.secondaryCredential.slot}`
      );
    }
    if (operation.credentialInjection && !operation.credentialSlot) {
      issues.push(`operations: ${operation.id} declares credential injection without a slot`);
    }
    if (
      operation.secondaryCredential &&
      (operation.credentialSlot === undefined || operation.credentialInjection === undefined)
    ) {
      issues.push(
        `operations: ${operation.id} secondary credential requires a primary credential slot and injection`
      );
    }
    if (
      operation.secondaryCredential &&
      (operation.secondaryCredential.slot === operation.credentialSlot ||
        sameCredentialLocation(
          operation.credentialInjection,
          operation.secondaryCredential.injection
        ))
    ) {
      issues.push(
        `operations: ${operation.id} secondary credential must use a distinct slot and location`
      );
    }

    if (
      operation.source.type === "http" &&
      operation.credentialSlot &&
      !operation.credentialInjection
    ) {
      issues.push(`operations: ${operation.id} credential injection is required for native HTTP`);
    }
    const baseUrl =
      operation.source.type === "graphql" ? operation.source.url : operation.source.baseUrl;
    const originField = baseUrl === undefined ? undefined : oimOriginPlaceholder(baseUrl);
    if (originField !== undefined) {
      const declared = (manifest.auth?.configurationFields ?? []).find(
        (candidate) => candidate.id === originField
      );
      if (declared === undefined) {
        issues.push(
          `operations: ${operation.id} base URL uses {${originField}}, which no configuration field declares`
        );
      } else if (declared.type !== "url" && declared.type !== "string") {
        issues.push(
          `operations: ${operation.id} base URL placeholder {${originField}} must be a url or string field`
        );
      }
      const allowed = manifest.auth?.allowedOriginHosts ?? [];
      if (allowed.length === 0) {
        issues.push(
          `operations: ${operation.id} uses a templated base URL without auth.allowedOriginHosts`
        );
      }
      for (const pattern of allowed) {
        if (!publicHostname(pattern.replace(/^\*\./, ""))) {
          issues.push(`auth: allowed origin host ${pattern} is not a public hostname`);
        }
      }
    }
    if (operation.credentialInjection) {
      const tokenCount = operation.credentialInjection.format.split("{token}").length - 1;
      if (tokenCount !== 1 || /[\r\n]/.test(operation.credentialInjection.format)) {
        issues.push(
          `operations: ${operation.id} credential injection format must contain one {token}`
        );
      }
      if (operation.secondaryCredential) {
        const tokenCount =
          operation.secondaryCredential.injection.format.split("{token}").length - 1;
        if (tokenCount !== 1 || /[\r\n]/.test(operation.secondaryCredential.injection.format)) {
          issues.push(
            `operations: ${operation.id} secondary credential injection format must contain one {token}`
          );
        }
      }
    }
    if (operation.response.mode !== "binary") {
      const responseSchemaIssue = embeddedSchemaIssue(operation.response.schema);
      if (responseSchemaIssue) {
        issues.push(`operations: ${operation.id} response schema ${responseSchemaIssue}`);
      }
    }

    if (manifest.auth?.healthCheckOperationId) {
      const healthOperation = manifest.operations.find(
        (operation) => operation.id === manifest.auth?.healthCheckOperationId
      );
      if (!healthOperation) {
        issues.push(
          `auth: health check references unknown operation ${manifest.auth.healthCheckOperationId}`
        );
      } else if (healthOperation.effect !== "read") {
        issues.push("auth: health check operation must have read effect");
      }
    }

    if (operation.source.type === "http") {
      const configuredOrigin = oimOriginPlaceholder(operation.source.baseUrl);
      const baseUrl = configuredOrigin ? undefined : validHttpsUrl(operation.source.baseUrl);
      if (!configuredOrigin) {
        if (!baseUrl) {
          issues.push(`operations: ${operation.id} baseUrl is not a valid HTTPS URL`);
        } else if (!publicHostname(baseUrl.hostname)) {
          issues.push(`operations: ${operation.id} baseUrl must use a public HTTPS URL`);
        }
      }
      if (!operation.source.path.startsWith("/") || operation.source.path.startsWith("//")) {
        issues.push(`operations: ${operation.id} HTTP path must start with exactly one slash`);
      } else if (baseUrl && new URL(operation.source.path, baseUrl).origin !== baseUrl.origin) {
        issues.push(`operations: ${operation.id} HTTP path changes the declared origin`);
      }
      const parameterNames = new Set<string>();
      const pathParameters = new Set<string>();
      for (const parameter of operation.source.parameters ?? []) {
        if (parameterNames.has(parameter.name)) {
          issues.push(
            `operations: ${operation.id} HTTP parameter ${parameter.name} is declared more than once`
          );
        }
        parameterNames.add(parameter.name);
        const schemaIssue = embeddedSchemaIssue(parameter.schema);
        if (schemaIssue) {
          issues.push(
            `operations: ${operation.id} HTTP parameter ${parameter.name} schema ${schemaIssue}`
          );
        }
        if (parameter.in === "path") {
          pathParameters.add(parameter.name);
          if (parameter.required === false) {
            issues.push(
              `operations: ${operation.id} HTTP path parameter ${parameter.name} cannot be optional`
            );
          }
        }
      }
      const placeholders = new Set(
        [...operation.source.path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] ?? "")
      );
      for (const placeholder of placeholders) {
        if (pathParameters.has(placeholder)) continue;
        // Core 1.1 widened what a path placeholder may name: the credential, when the operation
        // declares path injection, and a non-secret configuration field, so a per-account path
        // prefix is not something the Agent has to be told on every call.
        if (placeholder === PATH_CREDENTIAL_PLACEHOLDER) {
          if (
            operation.credentialInjection?.in !== "path" &&
            operation.secondaryCredential?.injection.in !== "path"
          ) {
            issues.push(
              `operations: ${operation.id} HTTP path uses {${PATH_CREDENTIAL_PLACEHOLDER}} without path credential injection`
            );
          }
          continue;
        }
        const configured = (manifest.auth?.configurationFields ?? []).find(
          (candidate) => candidate.id === placeholder
        );
        if (configured === undefined) {
          issues.push(
            `operations: ${operation.id} HTTP path placeholder ${placeholder} has no parameter`
          );
        } else if (configured.type !== "url" && configured.type !== "string") {
          issues.push(
            `operations: ${operation.id} HTTP path placeholder {${placeholder}} must be a url or string field`
          );
        }
      }
      for (const parameter of pathParameters) {
        if (!placeholders.has(parameter)) {
          issues.push(
            `operations: ${operation.id} HTTP path parameter ${parameter} has no placeholder`
          );
        }
      }
    }

    if (operation.source.type === "openapi") {
      if (operation.source.baseUrl && oimOriginPlaceholder(operation.source.baseUrl)) {
        // See the http branch: the bound lives in auth.allowedOriginHosts.
      } else if (operation.source.baseUrl) {
        const baseUrl = validHttpsUrl(operation.source.baseUrl);
        if (!baseUrl) {
          issues.push(`operations: ${operation.id} baseUrl is not a valid HTTPS URL`);
        } else if (!publicHostname(baseUrl.hostname)) {
          issues.push(`operations: ${operation.id} baseUrl must use a public HTTPS URL`);
        }
      }
      const file = files.get(operation.source.file);
      if (!file) {
        issues.push(
          `operations: ${operation.id} references undeclared OpenAPI file ${operation.source.file}`
        );
      } else if (file.role !== "openapi") {
        issues.push(
          `operations: ${operation.id} references ${operation.source.file} as OpenAPI, but its role is ${file.role}`
        );
      }
    }

    if (operation.source.type === "graphql") {
      if (/[{}]/.test(operation.source.url)) {
        if (
          !/^https:\/\/\{[a-z][a-z0-9_]{1,63}\}(?::[1-9][0-9]{0,4})?(?:\/[^{}]*)?$/.test(
            operation.source.url
          )
        ) {
          issues.push(
            `operations: ${operation.id} GraphQL URL requires one complete host placeholder`
          );
        }
      } else {
        const url = validHttpsUrl(operation.source.url);
        if (!url) {
          issues.push(`operations: ${operation.id} URL is not a valid HTTPS URL`);
        } else if (!publicHostname(url.hostname)) {
          issues.push(`operations: ${operation.id} URL must use a public HTTPS URL`);
        }
      }
      const file = files.get(operation.source.documentFile);
      if (!file) {
        issues.push(
          `operations: ${operation.id} references undeclared GraphQL file ${operation.source.documentFile}`
        );
      } else if (file.role !== "graphql") {
        issues.push(
          `operations: ${operation.id} references ${operation.source.documentFile} as GraphQL, but its role is ${file.role}`
        );
      }
    }
  }

  for (const step of manifest.auth?.steps ?? []) {
    if (step.type !== "webhook") continue;
    const register = manifest.operations.find((operation) => operation.id === step.operationId);
    const unregister = manifest.operations.find(
      (operation) => operation.id === step.unregisterOperationId
    );
    if (register === undefined) {
      issues.push(`auth: step ${step.id} references undeclared operation ${step.operationId}`);
    } else if (
      register.source.type !== "http" ||
      !["create", "update", "delete", "send", "admin"].includes(register.effect)
    ) {
      issues.push(`auth: step ${step.id} registration operation must be a mutating HTTP operation`);
    }
    if (unregister === undefined) {
      issues.push(
        `auth: step ${step.id} references undeclared operation ${step.unregisterOperationId}`
      );
    } else if (
      unregister.source.type !== "http" ||
      !["create", "update", "delete", "send", "admin"].includes(unregister.effect)
    ) {
      issues.push(
        `auth: step ${step.id} unregistration operation must be a mutating HTTP operation`
      );
    }
    if (manifest.events?.verification.secretSlot !== step.secretSlot) {
      issues.push(
        `auth: step ${step.id} secretSlot must match events verification secretSlot ${manifest.events?.verification.secretSlot ?? "none"}`
      );
    }
  }

  if (manifest.hooks && manifest.profiles.hooks !== OIM_PROFILE_VERSIONS.hooks) {
    issues.push('profiles: hooks "1.0" is required when hooks are declared');
  }

  for (const hook of manifest.hooks ?? []) {
    const file = files.get(hook.file);
    if (!file) {
      issues.push(`hooks: ${hook.kind} references undeclared hook file ${hook.file}`);
    } else if (file.role !== "hook") {
      issues.push(`hooks: ${hook.kind} references ${hook.file}, but its role is ${file.role}`);
    }
  }

  issues.push(...oimCoreExtensionIssues(manifest));
  issues.push(...oimEventsIssues(manifest));
  issues.push(...oimPollingIngressIssues(manifest));
  issues.push(...oimKnowledgeIssues(manifest));

  return issues;
}

function sameCredentialLocation(
  primary: OimOperation["credentialInjection"],
  secondary: NonNullable<OimOperation["secondaryCredential"]>["injection"]
): boolean {
  if (primary === undefined || primary.in !== secondary.in) return false;
  if (primary.in === "path" || secondary.in === "path") return true;
  return primary.name === secondary.name;
}

/** The `path` placeholder a path-injected credential fills. Reserved; never a parameter name. */
export const PATH_CREDENTIAL_PLACEHOLDER = "credential";

/** Whether a JSON Schema fragment describes a value that URL-encodes as a single scalar. */
function formEncodableSchema(schema: unknown): boolean {
  const shape = record(schema);
  if (shape === undefined) return false;
  const { type } = shape;
  if (typeof type !== "string") return false;
  return type === "string" || type === "number" || type === "integer" || type === "boolean";
}

/**
 * Coherence rules for the constructs Core 1.1 added.
 *
 * Kept together rather than folded into the operation loop because they share one job: each is a
 * case where the addition would otherwise let a manifest promise something the runtime cannot
 * honour — a credential that moves the host, a body the provider cannot parse, a cursor written
 * into a field that does not exist.
 */
function oimCoreExtensionIssues(manifest: OimManifest): string[] {
  const issues: string[] = [];
  const used = new Set<string>();
  const configured = new Map(
    (manifest.auth?.configurationFields ?? []).map((field) => [field.id, field])
  );

  for (const operation of manifest.operations) {
    const { source, credentialInjection, secondaryCredential, pagination } = operation;

    if (source.type === "graphql" && oimOriginPlaceholder(source.url) !== undefined) {
      used.add("source.url configuration placeholder");
    }
    if (secondaryCredential !== undefined) {
      used.add("secondaryCredential");
    }

    for (const injection of [credentialInjection, secondaryCredential?.injection]) {
      if (injection?.in !== "path") continue;
      used.add("credentialInjection.in: path");
      if (source.type !== "http") {
        issues.push(
          `operations: ${operation.id} path credential injection requires an HTTP source`
        );
      } else {
        const occurrences = source.path.split(`{${PATH_CREDENTIAL_PLACEHOLDER}}`).length - 1;
        if (occurrences !== 1) {
          issues.push(
            `operations: ${operation.id} path credential injection needs exactly one {${PATH_CREDENTIAL_PLACEHOLDER}} in path`
          );
        }
        if (source.baseUrl.includes(`{${PATH_CREDENTIAL_PLACEHOLDER}}`)) {
          issues.push(
            `operations: ${operation.id} may not place a credential in baseUrl, only in path`
          );
        }
      }
    }

    if (source.type === "http") {
      if (source.contentType !== undefined) used.add("source.contentType");
      if (source.contentType === "form") {
        if (operation.requestSchema === undefined) {
          issues.push(`operations: ${operation.id} form content type requires a request schema`);
        } else {
          const properties = schemaProperties(operation.requestSchema);
          if (properties === undefined) {
            issues.push(
              `operations: ${operation.id} form request schema must declare object properties`
            );
          } else {
            for (const [name, property] of Object.entries(properties)) {
              if (!formEncodableSchema(property)) {
                issues.push(
                  `operations: ${operation.id} form request field ${name} must be a scalar; nested values have no portable encoding`
                );
              }
            }
          }
        }
      }
      if (source.contentType === "multipart") {
        used.add("source.contentType: multipart");
        used.add("source.multipart");
        if (operation.requestSchema === undefined) {
          issues.push(
            `operations: ${operation.id} multipart content type requires a request schema`
          );
        }
        if (source.multipart === undefined) {
          issues.push(`operations: ${operation.id} multipart content type requires declared parts`);
        } else {
          const names = new Set<string>();
          const pointers = new Set<string>();
          for (const part of source.multipart.parts) {
            if (names.has(part.name)) {
              issues.push(
                `operations: ${operation.id} multipart part ${part.name} is declared more than once`
              );
            }
            names.add(part.name);
            if (pointers.has(part.pointer)) {
              issues.push(
                `operations: ${operation.id} multipart pointer ${part.pointer} is declared more than once`
              );
            }
            pointers.add(part.pointer);
          }
        }
      } else if (source.multipart !== undefined) {
        issues.push(`operations: ${operation.id} multipart parts require multipart content type`);
      }
      for (const parameter of source.parameters ?? []) {
        if (parameter.configurationField !== undefined) {
          used.add("parameter.configurationField");
          if (parameter.value !== undefined) {
            issues.push(
              `operations: ${operation.id} parameter ${parameter.name} cannot combine value and configurationField`
            );
          }
          const field = configured.get(parameter.configurationField);
          if (field === undefined) {
            issues.push(
              `operations: ${operation.id} parameter ${parameter.name} references undeclared configuration field ${parameter.configurationField}`
            );
          } else {
            const type = field.type === "url" ? "string" : field.type;
            if (
              parameter.schema.type !== type &&
              !(type === "integer" && parameter.schema.type === "number")
            ) {
              issues.push(
                `operations: ${operation.id} parameter ${parameter.name} schema is incompatible with configuration field ${field.id}`
              );
            }
          }
        }
        if (parameter.value === undefined) continue;
        used.add("parameter.value");
        if (parameter.required !== undefined) {
          issues.push(
            `operations: ${operation.id} parameter ${parameter.name} pins a value, so required is meaningless`
          );
        }
        if (/[\r\n]/.test(parameter.value)) {
          issues.push(
            `operations: ${operation.id} parameter ${parameter.name} value may not contain a newline`
          );
        }
      }
      for (const [, name] of source.path.matchAll(/\{([^{}]+)\}/g)) {
        if (name !== undefined && configured.has(name)) used.add("path configuration placeholder");
      }
    }

    if (pagination?.type === "body_cursor") {
      used.add("pagination.type: body_cursor");
      if (source.type !== "http") {
        issues.push(`operations: ${operation.id} body cursor pagination requires an HTTP source`);
      }
      if (operation.requestSchema === undefined) {
        issues.push(
          `operations: ${operation.id} body cursor pagination requires a request schema to write into`
        );
      }
      if (pagination.requestPointer === "/") {
        issues.push(
          `operations: ${operation.id} body cursor requestPointer must name a field, not the whole body`
        );
      }
    }

    if (operation.response.mode === "binary") {
      used.add("response.mode: binary");
      if (source.type !== "http") {
        issues.push(`operations: ${operation.id} binary response mode requires an HTTP source`);
      }
      if (pagination !== undefined) {
        issues.push(`operations: ${operation.id} binary response mode does not support pagination`);
      }
    }
  }

  const core12 = new Set(OIM_CORE_1_2_FEATURES);
  const needs12 = [...used].filter((feature) =>
    core12.has(feature as (typeof OIM_CORE_1_2_FEATURES)[number])
  );
  const needs11 = [...used].filter(
    (feature) => !core12.has(feature as (typeof OIM_CORE_1_2_FEATURES)[number])
  );
  if (needs11.length > 0 && manifest.profiles.core === "1.0") {
    issues.push(`profiles: core "1.1" is required for ${needs11.sort().join(", ")}`);
  }
  if (needs12.length > 0 && manifest.profiles.core !== "1.2") {
    issues.push(`profiles: core "1.2" is required for ${needs12.sort().join(", ")}`);
  }
  return issues;
}

/** Effect classes a Knowledge role may name. Knowledge sync reads; writes stay ordinary Tools. */
const KNOWLEDGE_READ_EFFECTS = new Set(["read", "sensitive_read"]);

/**
 * Whether an operation is known to accept a named request parameter.
 *
 * `undefined` means unknowable here — an OpenAPI or GraphQL operation keeps its parameters in a
 * companion file this function does not parse. Refusing those would reject valid manifests, so
 * the check reports only what it can see.
 */
function operationAcceptsParameter(operation: OimOperation, name: string): boolean | undefined {
  if (operation.source.type === "http") {
    const declared = operation.source.parameters?.some((parameter) => parameter.name === name);
    if (declared) return true;
  }
  const properties = operation.requestSchema?.properties;
  if (properties && typeof properties === "object") {
    return Object.hasOwn(properties as Record<string, unknown>, name);
  }
  if (operation.source.type === "http") return operation.source.parameters ? false : undefined;
  return undefined;
}

/**
 * Coherence rules for the Knowledge profile.
 *
 * Every rule here is a case where a manifest would compile into a sync that silently indexes the
 * wrong thing — content without readers, a cursor that never advances, an item id read from a
 * field the provider is free to change. A sync built on any of those widens access or loses
 * content quietly, so the manifest is refused rather than installed.
 */
function oimKnowledgeIssues(manifest: OimManifest): string[] {
  const knowledge = manifest.knowledge;
  if (!knowledge) return [];
  const issues: string[] = [];
  const profileVersion = manifest.profiles.knowledge;

  if (profileVersion === undefined || !OIM_KNOWLEDGE_PROFILE_VERSIONS.includes(profileVersion)) {
    issues.push('profiles: knowledge "1.0" or "1.1" is required when knowledge is declared');
  }

  const operations = new Map(manifest.operations.map((operation) => [operation.id, operation]));

  /** Resolve a role's operation, reporting the two ways it can be wrong. */
  const roleOperation = (role: string, operationId: string): OimOperation | undefined => {
    const operation = operations.get(operationId);
    if (!operation) {
      issues.push(`knowledge: ${role} references undeclared operation ${operationId}`);
      return undefined;
    }
    if (!KNOWLEDGE_READ_EFFECTS.has(operation.effect)) {
      issues.push(
        `knowledge: ${role} operation ${operationId} is ${operation.effect}, but Knowledge sync is read-only`
      );
    }
    return operation;
  };

  const requireParameter = (role: string, operation: OimOperation | undefined, name: string) => {
    if (!operation) return;
    if (operationAcceptsParameter(operation, name) === false) {
      issues.push(`knowledge: ${role} operation ${operation.id} declares no parameter ${name}`);
    }
  };
  const requireFieldParameters = (
    role: string,
    operation: OimOperation | undefined,
    parameters: Readonly<Record<string, string>> | undefined
  ) => {
    for (const [name, field] of Object.entries(parameters ?? {})) {
      requireParameter(role, operation, name);
      if (!Object.hasOwn(knowledge.list.mapping.itemFields ?? {}, field)) {
        issues.push(`knowledge: ${role} parameter ${name} references unknown item field ${field}`);
      }
    }
  };
  const rejectDuplicateFieldParameter = (
    role: string,
    parameters: Readonly<Record<string, string>> | undefined,
    reserved: readonly (string | undefined)[]
  ) => {
    for (const name of reserved) {
      if (name !== undefined && Object.hasOwn(parameters ?? {}, name)) {
        issues.push(`knowledge: ${role} parameters duplicate reserved parameter ${name}`);
      }
    }
  };

  const kindIds = new Set<string>();
  for (const kind of knowledge.sourceKinds) {
    if (kindIds.has(kind.id)) issues.push(`knowledge: duplicate source kind ${kind.id}`);
    kindIds.add(kind.id);
    if (kind.discoverOperationId !== undefined) {
      roleOperation(`sourceKinds.${kind.id}.discover`, kind.discoverOperationId);
      if (kind.discoverMapping === undefined || kind.discoverItemsPointer === undefined) {
        issues.push(
          `knowledge: source kind ${kind.id} declares a discovery operation without discoverItemsPointer and discoverMapping`
        );
      }
    } else if (kind.discoverMapping !== undefined || kind.discoverItemsPointer !== undefined) {
      issues.push(
        `knowledge: source kind ${kind.id} maps discovery output but names no discovery operation`
      );
    }
  }

  const list = roleOperation("list", knowledge.list.operationId);
  if (knowledge.list.scopeParameter !== undefined) {
    requireParameter("list", list, knowledge.list.scopeParameter);
  }
  const itemFields = knowledge.list.mapping.itemFields ?? {};
  const itemIdentity = knowledge.list.mapping.itemIdentity;
  if ((knowledge.list.mapping.itemId === undefined) === (itemIdentity === undefined)) {
    issues.push("knowledge: list mapping requires exactly one of itemId or itemIdentity");
  }
  if (itemIdentity !== undefined) {
    for (const field of itemIdentity) {
      if (!Object.hasOwn(itemFields, field)) {
        issues.push(`knowledge: list itemIdentity references unknown item field ${field}`);
      }
    }
  }

  const cursor = knowledge.list.cursor;
  if (cursor.kind === "operation_pagination" && list !== undefined && !list.pagination) {
    issues.push(
      `knowledge: list resumes from operation pagination, but ${list.id} declares no pagination`
    );
  }
  if (cursor.kind === "response_pointer") {
    if (cursor.pointer === undefined || cursor.requestParameter === undefined) {
      issues.push("knowledge: response_pointer cursor requires pointer and requestParameter");
    } else {
      requireParameter("list cursor", list, cursor.requestParameter);
    }
  }
  if (
    cursor.kind === "none" &&
    (cursor.pointer !== undefined || cursor.requestParameter !== undefined)
  ) {
    issues.push("knowledge: cursor none declares no resume point");
  }
  // Without a cursor every Run re-reads the whole source, so a full walk has to be the plan
  // rather than an accident: only a full-list deletion sweep makes that affordable and correct.
  if (cursor.kind === "none" && knowledge.deletion.kind !== "absent_from_full_list") {
    issues.push(
      "knowledge: cursor none re-reads the whole source, so deletion must be absent_from_full_list"
    );
  }

  const content = roleOperation("content", knowledge.content.operationId);
  if (knowledge.content.itemParameter !== undefined) {
    requireParameter("content", content, knowledge.content.itemParameter);
  }
  requireFieldParameters("content", content, knowledge.content.parameters);
  rejectDuplicateFieldParameter("content", knowledge.content.parameters, [
    knowledge.content.itemParameter,
  ]);
  if (
    knowledge.content.itemParameter === undefined &&
    Object.keys(knowledge.content.parameters ?? {}).length === 0
  ) {
    issues.push("knowledge: content declares no item parameter bindings");
  }
  if (itemIdentity !== undefined && knowledge.content.itemParameter !== undefined) {
    issues.push(
      "knowledge: content itemParameter cannot address a composite identity; bind named fields with parameters"
    );
  }

  const acl = knowledge.acl;
  const aclOperation = roleOperation("acl", acl.operationId);
  if (acl.mode === "item") {
    if (acl.itemParameter !== undefined) requireParameter("acl", aclOperation, acl.itemParameter);
    requireFieldParameters("acl", aclOperation, acl.parameters);
    rejectDuplicateFieldParameter("acl", acl.parameters, [acl.itemParameter]);
    if (acl.itemParameter === undefined && Object.keys(acl.parameters ?? {}).length === 0) {
      issues.push("knowledge: item acl declares no item parameter bindings");
    }
    if (itemIdentity !== undefined && acl.itemParameter !== undefined) {
      issues.push(
        "knowledge: item acl itemParameter cannot address a composite identity; bind named fields with parameters"
      );
    }
  } else {
    requireParameter("acl", aclOperation, acl.scopeParameter);
  }
  const entry = acl.entry;
  if (
    entry.providerUserId === undefined &&
    entry.providerGroupId === undefined &&
    entry.domain === undefined
  ) {
    issues.push("knowledge: acl entry maps no principal identifier, so readers cannot be resolved");
  }
  if (entry.kindPointer === undefined && entry.defaultKind === undefined) {
    issues.push("knowledge: acl entry needs kindPointer or defaultKind");
  }
  if (entry.kindPointer !== undefined && entry.kindValues === undefined) {
    issues.push("knowledge: acl entry reads a kind but declares no kindValues to interpret it");
  }
  if (entry.kindPointer === undefined && entry.kindValues !== undefined) {
    issues.push("knowledge: acl entry declares kindValues but reads no kind");
  }
  const kindValues = entry.kindValues;
  if (kindValues) {
    const seen = new Map<string, string>();
    for (const [kind, values] of Object.entries(kindValues)) {
      for (const value of values ?? []) {
        const owner = seen.get(value);
        if (owner !== undefined) {
          issues.push(`knowledge: acl kind value ${value} maps to both ${owner} and ${kind}`);
        }
        seen.set(value, kind);
      }
    }
  }

  if (knowledge.identity?.user) {
    const user = roleOperation("identity.user", knowledge.identity.user.operationId);
    requireParameter("identity.user", user, knowledge.identity.user.idParameter);
    // An unverified address is chosen by whoever holds the provider account, so treating one as
    // proof of identity hands a TulipFarm principal's access to anyone who can type it.
    if (
      knowledge.identity.user.mapping.email !== undefined &&
      knowledge.identity.user.mapping.emailVerified === undefined
    ) {
      issues.push(
        "knowledge: identity.user maps email without emailVerified, so no address can be trusted for matching"
      );
    }
  }
  if (knowledge.identity?.group) {
    const group = roleOperation("identity.group", knowledge.identity.group.operationId);
    requireParameter("identity.group", group, knowledge.identity.group.idParameter);
  }
  if (entry.providerGroupId !== undefined && knowledge.identity?.group === undefined) {
    issues.push(
      "knowledge: acl entry grants to groups, but no identity.group lookup can expand them"
    );
  }

  const deletion = knowledge.deletion;
  if (deletion.kind === "list_flag" && knowledge.list.mapping.deleted === undefined) {
    issues.push("knowledge: list_flag deletion requires list.mapping.deleted");
  }
  if (deletion.kind === "operation") {
    if (deletion.operationId === undefined || deletion.itemsPointer === undefined) {
      issues.push("knowledge: operation deletion requires operationId and itemsPointer");
    } else {
      const removed = roleOperation("deletion", deletion.operationId);
      if (deletion.scopeParameter !== undefined) {
        requireParameter("deletion", removed, deletion.scopeParameter);
      }
      requireFieldParameters("deletion", removed, deletion.parameters);
      rejectDuplicateFieldParameter("deletion", deletion.parameters, [deletion.scopeParameter]);
      for (const [name, field] of Object.entries(deletion.parameters ?? {})) {
        if (itemFields[field]?.source !== "scope") {
          issues.push(`knowledge: deletion parameter ${name} requires scope item field ${field}`);
        }
      }
      if (deletion.itemIdPointer === undefined) {
        issues.push("knowledge: operation deletion requires itemIdPointer");
      }
    }
  }
  if (deletion.kind !== "operation" && deletion.operationId !== undefined) {
    issues.push(`knowledge: deletion ${deletion.kind} names an operation it never calls`);
  }
  if (deletion.kind !== "operation" && deletion.parameters !== undefined) {
    issues.push(
      `knowledge: deletion ${deletion.kind} binds parameters for an operation it never calls`
    );
  }

  if (knowledge.liveAuthorization) {
    const live = roleOperation("liveAuthorization", knowledge.liveAuthorization.operationId);
    if (knowledge.liveAuthorization.itemParameter !== undefined) {
      requireParameter("liveAuthorization", live, knowledge.liveAuthorization.itemParameter);
    }
    requireFieldParameters("liveAuthorization", live, knowledge.liveAuthorization.parameters);
    rejectDuplicateFieldParameter("liveAuthorization", knowledge.liveAuthorization.parameters, [
      knowledge.liveAuthorization.itemParameter,
      knowledge.liveAuthorization.principalParameter,
    ]);
    if (
      (knowledge.liveAuthorization.allowedPointer === undefined) ===
      (knowledge.liveAuthorization.principalSet === undefined)
    ) {
      issues.push(
        "knowledge: liveAuthorization requires exactly one of allowedPointer or principalSet"
      );
    }
    if (
      knowledge.liveAuthorization.principalSet !== undefined &&
      knowledge.liveAuthorization.principalParameter !== undefined
    ) {
      issues.push(
        "knowledge: liveAuthorization principalSet compares the linked identity locally and cannot declare principalParameter"
      );
    }
    if (
      knowledge.liveAuthorization.itemParameter === undefined &&
      Object.keys(knowledge.liveAuthorization.parameters ?? {}).length === 0
    ) {
      issues.push("knowledge: liveAuthorization declares no source context parameter");
    }
    if (itemIdentity !== undefined && knowledge.liveAuthorization.itemParameter !== undefined) {
      issues.push(
        "knowledge: liveAuthorization itemParameter cannot address a composite identity; bind named fields with parameters"
      );
    }
  }

  const knowledge11Features: string[] = [];
  if (knowledge.list.mapping.itemFields !== undefined) {
    knowledge11Features.push("list.mapping.itemFields");
  }
  if (knowledge.list.mapping.itemIdentity !== undefined) {
    knowledge11Features.push("list.mapping.itemIdentity");
  }
  if (typeof knowledge.content.mapping.content !== "string") {
    knowledge11Features.push("content.mapping.content scalar join");
  }
  if (knowledge.content.parameters !== undefined) {
    knowledge11Features.push("content.parameters");
  }
  if (acl.mode === "item" && acl.parameters !== undefined) {
    knowledge11Features.push("acl.parameters");
  }
  if (deletion.parameters !== undefined) {
    knowledge11Features.push("deletion.parameters");
  }
  if (knowledge.liveAuthorization?.parameters !== undefined) {
    knowledge11Features.push("liveAuthorization.parameters");
  }
  if (knowledge.liveAuthorization?.principalSet !== undefined) {
    knowledge11Features.push("liveAuthorization.principalSet");
  }

  const pointers: (string | undefined)[] = [
    ...knowledge.sourceKinds.flatMap((kind) => [
      kind.discoverItemsPointer,
      kind.discoverMapping?.id,
      kind.discoverMapping?.label,
    ]),
    knowledge.list.itemsPointer,
    knowledge.list.mapping.itemId,
    ...Object.values(itemFields).map((field) =>
      field.source === "item" ? field.pointer : undefined
    ),
    knowledge.list.mapping.revision,
    knowledge.list.mapping.title,
    knowledge.list.mapping.sourceUrl,
    knowledge.list.mapping.updatedAt,
    knowledge.list.mapping.contentType,
    knowledge.list.mapping.deleted,
    knowledge.list.cursor.pointer,
    typeof knowledge.content.mapping.content === "string"
      ? knowledge.content.mapping.content
      : knowledge.content.mapping.content.itemsPointer,
    typeof knowledge.content.mapping.content === "string"
      ? undefined
      : knowledge.content.mapping.content.itemPointer,
    knowledge.content.mapping.contentType,
    knowledge.content.mapping.revision,
    knowledge.content.mapping.title,
    knowledge.content.mapping.sourceUrl,
    knowledge.content.mapping.updatedAt,
    acl.entriesPointer,
    acl.entry.kindPointer,
    acl.entry.providerUserId,
    acl.entry.providerGroupId,
    acl.entry.domain,
    knowledge.identity?.user?.mapping.providerId,
    knowledge.identity?.user?.mapping.email,
    knowledge.identity?.user?.mapping.emailVerified,
    knowledge.identity?.group?.membersPointer,
    knowledge.identity?.group?.mapping.providerId,
    knowledge.identity?.group?.mapping.memberUserId,
    deletion.itemsPointer,
    deletion.itemIdPointer,
    knowledge.liveAuthorization?.allowedPointer,
    knowledge.liveAuthorization?.principalSet?.entriesPointer,
    knowledge.liveAuthorization?.principalSet?.principalIdPointer,
  ];
  if (pointers.includes("")) knowledge11Features.push('RFC 6901 root pointer ""');

  if (profileVersion === "1.0" && knowledge11Features.length > 0) {
    issues.push(
      `profiles: knowledge "1.1" is required for ${knowledge11Features.sort().join(", ")}`
    );
  }

  if (knowledge.guideFile !== undefined) {
    const file = (manifest.files ?? []).find((candidate) => candidate.path === knowledge.guideFile);
    if (!file) {
      issues.push(`knowledge: guideFile ${knowledge.guideFile} is not a declared file`);
    } else if (file.role !== "guide") {
      issues.push(
        `knowledge: guideFile ${knowledge.guideFile} is declared with role ${file.role}, not guide`
      );
    }
  }

  return issues;
}

/** Which verification schemes read a signature header, and therefore require one. */
const SIGNED_SCHEMES = new Set([
  "twilio_hmac_sha1",
  "hmac_sha256",
  "hmac_sha512",
  "ed25519",
  "rsa_sha256",
  "jwt",
]);

/** Schemes whose signature input is the declared template rather than a protocol-defined value. */
const TIMESTAMP_SIGNING_SCHEMES = new Set(["hmac_sha256", "hmac_sha512", "ed25519", "rsa_sha256"]);

function oimEventTypeIssues(
  manifest: OimManifest,
  eventTypes: readonly OimEventType[],
  path: "events" | "ingress",
  signatureHeader?: string
): string[] {
  const issues: string[] = [];
  const normalizers = new Set(
    (manifest.hooks ?? [])
      .filter((hook) => hook.kind === "response_normalize")
      .map((hook) => hook.export)
  );
  const seen = new Set<string>();
  for (const eventType of eventTypes) {
    if (seen.has(eventType.type)) {
      issues.push(`${path}: duplicate event type ${eventType.type}`);
    }
    seen.add(eventType.type);
    if (eventType.selector.equals === undefined && eventType.selector.matches === undefined) {
      issues.push(`${path}: ${eventType.type} selector needs equals or matches`);
    }
    if (eventType.selector.equals !== undefined && eventType.selector.matches !== undefined) {
      issues.push(`${path}: ${eventType.type} selector cannot use both equals and matches`);
    }
    if (eventType.selector.matches !== undefined && !safeRegex(eventType.selector.matches)) {
      issues.push(`${path}: ${eventType.type} selector pattern is not a safe regular expression`);
    }
    if (eventType.normalize !== undefined && !normalizers.has(eventType.normalize)) {
      issues.push(
        `${path}: ${eventType.type} normalizes with ${eventType.normalize}, which no response_normalize hook exports`
      );
    }
    if (
      signatureHeader !== undefined &&
      eventType.safeHeaders?.some((name) => name.toLowerCase() === signatureHeader.toLowerCase())
    ) {
      issues.push(`${path}: ${eventType.type} may not expose the signature header to a hook`);
    }
  }
  return issues;
}

/**
 * Coherence rules the JSON Schema cannot express.
 *
 * Every one of these is a case where a manifest validates structurally but would verify nothing at
 * runtime. Rejecting at parse time is the difference between an Integration that cannot be
 * installed and one that accepts forged deliveries.
 */
function oimEventsIssues(manifest: OimManifest): string[] {
  const events = manifest.events;
  if (!events) return [];
  const issues: string[] = [];

  if (manifest.profiles.events !== OIM_PROFILE_VERSIONS.events) {
    issues.push('profiles: events "1.0" is required when events are declared');
  }

  const { verification: check } = events;
  if (SIGNED_SCHEMES.has(check.scheme) && check.signatureHeader === undefined) {
    issues.push(`events: ${check.scheme} requires signatureHeader`);
  }
  if (check.scheme === "shared_secret") {
    if (check.signatureHeader === undefined) {
      issues.push("events: shared_secret requires the header carrying the Secret");
    }
    // A shared Secret is compared whole; a signing template would describe bytes nothing signs,
    // and an author who wrote one has misread the scheme rather than configured it.
    if (check.signingInput !== undefined) {
      issues.push("events: shared_secret does not sign a canonical input");
    }
  }
  if (check.scheme === "twilio_hmac_sha1") {
    if (check.signatureHeader?.toLowerCase() !== "x-twilio-signature") {
      issues.push("events: twilio_hmac_sha1 requires X-Twilio-Signature");
    }
    if (check.signatureEncoding !== "base64") {
      issues.push("events: twilio_hmac_sha1 requires base64 signatureEncoding");
    }
    if (
      check.signaturePrefix !== undefined ||
      check.signingInput !== undefined ||
      check.timestampHeader !== undefined ||
      check.toleranceSeconds !== undefined
    ) {
      issues.push(
        "events: twilio_hmac_sha1 signs the configured callback URL and decoded form fields"
      );
    }
  }
  if (check.timestampHeader !== undefined) {
    if (!TIMESTAMP_SIGNING_SCHEMES.has(check.scheme)) {
      issues.push(`events: ${check.scheme} cannot authenticate timestampHeader`);
    } else if (!(check.signingInput ?? "{body}").includes("{timestamp}")) {
      issues.push("events: timestampHeader requires signingInput to include {timestamp}");
    }
  }
  if (check.signingInput?.includes("{timestamp}") && check.timestampHeader === undefined) {
    issues.push("events: signingInput names {timestamp} but no timestampHeader is declared");
  }
  if (check.toleranceSeconds !== undefined && check.timestampHeader === undefined) {
    issues.push("events: toleranceSeconds has no effect without a timestampHeader");
  }
  if (check.scheme !== "jwt" && (check.issuer !== undefined || check.audience !== undefined)) {
    issues.push("events: issuer and audience apply only to jwt");
  }

  const dedup = events.deduplication;
  if (dedup.kind === "delivery_id_header" && dedup.header === undefined) {
    issues.push("events: delivery_id_header requires header");
  }
  if (dedup.kind === "body_pointer" && dedup.bodyPointer === undefined) {
    issues.push("events: body_pointer requires bodyPointer");
  }
  if (dedup.kind === "none" && (dedup.header !== undefined || dedup.bodyPointer !== undefined)) {
    issues.push("events: none declares no deduplication key");
  }

  const handshake = events.handshake;
  if (handshake?.kind === "echo_body_pointer" && handshake.bodyPointer === undefined) {
    issues.push("events: echo_body_pointer requires bodyPointer");
  }
  if (handshake?.kind === "echo_header" && handshake.header === undefined) {
    issues.push("events: echo_header requires header");
  }

  issues.push(...oimEventTypeIssues(manifest, events.eventTypes, "events", check.signatureHeader));

  return issues;
}

/** Coherence rules for pull ingress, which uses the Events profile's normalized event contract. */
function oimPollingIngressIssues(manifest: OimManifest): string[] {
  const ingress = manifest.ingress;
  if (ingress === undefined) return [];
  const issues: string[] = [];
  if (manifest.profiles.events !== OIM_PROFILE_VERSIONS.events) {
    issues.push('profiles: events "1.0" is required when polling ingress is declared');
  }
  if (ingress.eventTypes === undefined && manifest.events === undefined) {
    issues.push("ingress: polling requires eventTypes");
  }
  if (ingress.eventTypes !== undefined) {
    issues.push(...oimEventTypeIssues(manifest, ingress.eventTypes, "ingress"));
  }
  const operation = manifest.operations.find((candidate) => candidate.id === ingress.operationId);
  if (operation === undefined) {
    issues.push(`ingress: polling references undeclared operation ${ingress.operationId}`);
    return issues;
  }
  if (
    operation.source.type !== "http" ||
    (operation.effect !== "read" && operation.effect !== "sensitive_read")
  ) {
    issues.push(`ingress: polling operation ${operation.id} must be a read HTTP operation`);
  }
  if (operationAcceptsParameter(operation, ingress.cursor.requestParameter) === false) {
    issues.push(
      `ingress: polling operation ${operation.id} declares no parameter ${ingress.cursor.requestParameter}`
    );
  }
  return issues;
}

/**
 * Whether a selector pattern is a regular expression the runtime will run on provider input.
 *
 * Unbounded nesting of quantifiers is how a selector becomes a denial of service against the inbox
 * rather than a filter, so a pattern that cannot be judged is refused at authoring time.
 */
function safeRegex(pattern: string): boolean {
  if (/(\([^)]*[+*]\)[+*])|(\{\d+,\}[+*])/.test(pattern)) return false;
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

/** Cross-check a Connection against the exact Integration major version that owns it. */
export function oimConnectionIssues(connection: OimConnection, manifest: OimManifest): string[] {
  const issues: string[] = [];
  if (connection.status === "revoked" && connection.isDefault) {
    issues.push("isDefault: a revoked Connection cannot remain the default");
  }
  const majorVersion = Number(versionMajor(manifest.metadata.version));
  if (
    connection.integration.id !== manifest.metadata.id ||
    connection.integration.majorVersion !== majorVersion
  ) {
    issues.push("integration: Connection does not belong to this Integration major version");
  }

  const slots = new Map((manifest.auth?.credentialSlots ?? []).map((slot) => [slot.id, slot]));
  for (const slot of Object.keys(connection.secretBindings)) {
    if (!slots.has(slot)) {
      issues.push(`secretBindings: ${slot} is not declared by the Integration`);
    }
  }
  for (const [slot, declaration] of slots) {
    if (declaration.required !== false && connection.secretBindings[slot] === undefined) {
      issues.push(`secretBindings: required slot ${slot} is missing`);
    }
  }

  const configuration = new Map(
    (manifest.auth?.configurationFields ?? []).map((field) => [field.id, field])
  );
  for (const key of Object.keys(connection.configuration)) {
    const declaration = configuration.get(key);
    if (!declaration) {
      issues.push(`configuration: ${key} is not declared by the Integration`);
      continue;
    }
    const value = connection.configuration[key];
    const validType =
      (declaration.type === "string" && typeof value === "string") ||
      (declaration.type === "url" && typeof value === "string") ||
      (declaration.type === "boolean" && typeof value === "boolean") ||
      (declaration.type === "integer" && typeof value === "number" && Number.isInteger(value));
    if (!validType) {
      issues.push(`configuration: ${key} must have type ${declaration.type}`);
    }
  }
  for (const [key, declaration] of configuration) {
    if (declaration.required === true && connection.configuration[key] === undefined) {
      issues.push(`configuration: required field ${key} is missing`);
    }
  }
  for (const key of connection.agentVisibleConfiguration) {
    if (configuration.get(key)?.agentVisible !== true) {
      issues.push(
        `agentVisibleConfiguration: ${key} is not declared agent-visible by the Integration`
      );
    } else if (connection.configuration[key] === undefined) {
      issues.push(`agentVisibleConfiguration: ${key} has no configured value`);
    }
  }
  const registration = connection.webhookRegistration;
  if (registration !== undefined) {
    const step = (manifest.auth?.steps ?? []).find(
      (candidate): candidate is Extract<OimAuth["steps"][number], { type: "webhook" }> =>
        candidate.type === "webhook" && candidate.operationId === registration.operationId
    );
    if (
      step === undefined ||
      step.unregisterOperationId !== registration.unregisterOperationId ||
      step.secretSlot !== registration.secretSlot
    ) {
      issues.push("webhookRegistration: does not match a declared webhook step");
    }
    if (connection.secretBindings[registration.secretSlot] === undefined) {
      issues.push(
        `webhookRegistration: secret slot ${registration.secretSlot} has no bound Secret`
      );
    }
  }
  return issues;
}

/** Parse and fully validate an OIM `oim.yml`. */
export function parseOimManifest(source: string): OimManifest {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (cause) {
    throw new TulipFarmValidationError(
      "integration",
      "",
      `cannot parse OIM manifest YAML: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  const manifest = validateOimManifest(document);
  const issues = oimManifestIssues(manifest);
  if (issues.length > 0) {
    throw new TulipFarmValidationError("integration", "", issues.join("; "));
  }
  return manifest;
}

/**
 * Parse one OIM fixture companion.
 *
 * Fixtures are data for the recording transport, never a way to obtain runtime capabilities.
 * Reject those names explicitly so an author gets a useful refusal instead of a generic schema
 * error that could be mistaken for an unsupported response property.
 */
export function parseOimFixtureSuite(source: string): OimFixtureSuite {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (cause) {
    throw new TulipFarmValidationError(
      "integration",
      "",
      `cannot parse OIM fixture YAML: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  if (document !== null && typeof document === "object" && !Array.isArray(document)) {
    const suite = document as Record<string, unknown>;
    const candidates = [
      { name: "suite", value: suite },
      ...(Array.isArray(suite.cases)
        ? suite.cases.map((value) => ({
            name:
              value !== null &&
              typeof value === "object" &&
              typeof (value as { name?: unknown }).name === "string"
                ? ((value as { name: string }).name as string)
                : "unnamed",
            value,
          }))
        : []),
    ];
    for (const candidate of candidates) {
      if (candidate.value === null || typeof candidate.value !== "object") continue;
      const objects = [
        candidate.value,
        "configuration" in candidate.value &&
        candidate.value.configuration !== null &&
        typeof candidate.value.configuration === "object" &&
        !Array.isArray(candidate.value.configuration)
          ? candidate.value.configuration
          : undefined,
      ];
      for (const value of objects) {
        if (value === undefined) continue;
        for (const capability of ["credential", "credentials", "network", "clock", "now"]) {
          if (!Object.hasOwn(value, capability)) continue;
          throw new TulipFarmValidationError(
            "integration",
            "",
            `fixture ${candidate.name} refuses ${capability}`
          );
        }
      }
    }
  }
  return validateOimFixtureSuite(document);
}

/** Lowercase SHA-256 over the exact companion bytes. */
export function oimFileDigest(content: OimPackageContent): string {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return bytesToHex(sha256(bytes));
}

/**
 * Validate an exact companion-file set. The `oim.yml` entry point is supplied separately and
 * must not be included in `files`.
 */
export function oimPackageIssues(
  manifest: OimManifest,
  files: ReadonlyMap<string, OimPackageContent>
): string[] {
  const issues = oimManifestIssues(manifest);
  const declared = companionByPath(manifest);

  for (const file of manifest.files ?? []) {
    const content = files.get(file.path);
    if (content === undefined) {
      issues.push(`files: ${file.path} is declared but missing`);
    } else if (oimFileDigest(content) !== file.sha256) {
      issues.push(`files: ${file.path} digest does not match the manifest`);
    }
    if (content !== undefined) {
      const contentIssue = packageContentIssue(file, content);
      if (contentIssue) issues.push(`files: ${contentIssue}`);
    }
  }

  for (const path of [...files.keys()].sort()) {
    if (!declared.has(path)) issues.push(`files: ${path} is present but not declared`);
  }

  for (const operation of manifest.operations) {
    if (operation.source.type === "openapi") {
      const content = files.get(operation.source.file);
      if (content === undefined) continue;
      for (const issue of openApiOperationIssues(
        content,
        operation.source.operationId,
        operation.source.baseUrl !== undefined
      )) {
        issues.push(`operations: ${operation.id} ${issue}`);
      }
    }
    if (operation.source.type === "graphql") {
      const content = files.get(operation.source.documentFile);
      if (content === undefined) continue;
      const issue = graphqlOperationIssue(content, operation.source.operation);
      if (issue) issues.push(`operations: ${operation.id} ${issue}`);
    }
  }

  return issues;
}

/** Content address for the validated manifest, including every declared companion digest. */
export function oimPackageDigest(manifest: OimManifest): string {
  return canonicalHash(manifest);
}

function versionMajor(version: string): string {
  return version.split(".", 1)[0] ?? version;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(schema.properties);
}

function schemaRequired(schema: Record<string, unknown>): Set<string> {
  return new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : []
  );
}

type SchemaVariance = "input" | "output";

const CONSERVATIVE_KEYWORDS = [
  "$ref",
  "$defs",
  "definitions",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
  "patternProperties",
  "propertyNames",
  "contains",
  "minContains",
  "maxContains",
  "prefixItems",
  "multipleOf",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "contentSchema",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const;
const MINIMUM_KEYWORDS = [
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "minItems",
  "minProperties",
] as const;
const MAXIMUM_KEYWORDS = [
  "maximum",
  "exclusiveMaximum",
  "maxLength",
  "maxItems",
  "maxProperties",
] as const;

function changedSchemaIssue(path: string): string {
  const separator = path.lastIndexOf(".");
  return separator === -1
    ? `${path} schema changed incompatibly`
    : `${path.slice(0, separator)} changed property ${path.slice(separator + 1)}`;
}

function enumValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function schemaValueEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalHash(left) === canonicalHash(right);
}

function enumCompatibilityIssues(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  variance: SchemaVariance
): string[] {
  if (!Array.isArray(previous.enum) && !Array.isArray(next.enum)) return [];
  if (!Array.isArray(previous.enum) || !Array.isArray(next.enum)) {
    const becameRestricted =
      variance === "input" ? Array.isArray(next.enum) : Array.isArray(previous.enum);
    return becameRestricted ? [`${path} enum changed incompatibly`] : [];
  }

  const permitted = variance === "input" ? next.enum : previous.enum;
  const required = variance === "input" ? previous.enum : next.enum;
  const qualifier = variance === "input" ? "narrowed" : "broadened";
  return required
    .filter((value) => !permitted.some((candidate) => schemaValueEqual(candidate, value)))
    .map((value) => `${path} ${qualifier} enum value ${enumValue(value)}`);
}

function constraintIssues(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  variance: SchemaVariance
): string[] {
  const issues: string[] = [];
  for (const key of [...MINIMUM_KEYWORDS, ...MAXIMUM_KEYWORDS]) {
    const before = previous[key];
    const after = next[key];
    if (before === after) continue;
    const minimum = MINIMUM_KEYWORDS.includes(key as (typeof MINIMUM_KEYWORDS)[number]);
    let unsafe: boolean;
    if (before === undefined || after === undefined) {
      unsafe = variance === "input" ? before === undefined : after === undefined;
    } else if (typeof before === "number" && typeof after === "number") {
      unsafe =
        variance === "input"
          ? minimum
            ? after > before
            : after < before
          : minimum
            ? after < before
            : after > before;
    } else {
      unsafe = true;
    }
    if (unsafe) {
      issues.push(`${path} changed ${key} incompatibly`);
    }
  }

  for (const key of ["pattern", "format", "contentEncoding", "contentMediaType"] as const) {
    if (previous[key] === next[key]) continue;
    if (
      (variance === "input" && next[key] !== undefined) ||
      (variance === "output" && previous[key] !== undefined)
    ) {
      issues.push(`${path} changed ${key} incompatibly`);
    }
  }

  if (
    previous.uniqueItems !== next.uniqueItems &&
    ((variance === "input" && next.uniqueItems === true) ||
      (variance === "output" && previous.uniqueItems === true))
  ) {
    issues.push(`${path} changed uniqueItems incompatibly`);
  }
  return issues;
}

function additionalPropertiesIssues(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  variance: SchemaVariance
): string[] {
  const before = previous.additionalProperties ?? true;
  const after = next.additionalProperties ?? true;
  if (schemaValueEqual(before, after)) return [];

  if (variance === "input") {
    if (after === true) return [];
    if (before === false) return [];
    if (before === true || after === false) {
      return [`${path} narrowed additionalProperties`];
    }
  } else {
    if (before === true) return [];
    if (after === false) return [];
    if (after === true || before === false) {
      return [`${path} broadened additionalProperties`];
    }
  }

  const beforeSchema = record(before);
  const afterSchema = record(after);
  return beforeSchema && afterSchema
    ? schemaCompatibilityIssues(beforeSchema, afterSchema, `${path}.*`, variance)
    : [`${path} changed additionalProperties incompatibly`];
}

function schemaCompatibilityIssues(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  variance: SchemaVariance
): string[] {
  const conservativeIssues: string[] = [];
  for (const keyword of CONSERVATIVE_KEYWORDS) {
    if (!schemaValueEqual(previous[keyword], next[keyword])) {
      conservativeIssues.push(`${path} changed ${keyword} incompatibly`);
    }
  }
  if (
    !schemaValueEqual(previous.type, next.type) ||
    !schemaValueEqual(previous.const, next.const)
  ) {
    return [...conservativeIssues, changedSchemaIssue(path)];
  }

  const issues = [
    ...conservativeIssues,
    ...enumCompatibilityIssues(previous, next, path, variance),
    ...constraintIssues(previous, next, path, variance),
  ];

  const previousProperties = schemaProperties(previous);
  const nextProperties = schemaProperties(next);
  const objectContract =
    previous.type === "object" ||
    next.type === "object" ||
    previousProperties !== undefined ||
    nextProperties !== undefined ||
    previous.required !== undefined ||
    next.required !== undefined ||
    previous.additionalProperties !== undefined ||
    next.additionalProperties !== undefined;
  if (objectContract) {
    const before = previousProperties ?? {};
    const after = nextProperties ?? {};
    for (const [name, schema] of Object.entries(before)) {
      if (!(name in after)) {
        issues.push(`${path} removed property ${name}`);
        continue;
      }
      const beforeProperty = record(schema);
      const afterProperty = record(after[name]);
      if (!beforeProperty || !afterProperty) {
        if (!schemaValueEqual(schema, after[name])) {
          issues.push(`${path} changed property ${name}`);
        }
        continue;
      }
      issues.push(
        ...schemaCompatibilityIssues(beforeProperty, afterProperty, `${path}.${name}`, variance)
      );
    }
  }
  const previousRequired = schemaRequired(previous);
  const nextRequired = schemaRequired(next);
  const changedRequired =
    variance === "input"
      ? [...nextRequired].filter((name) => !previousRequired.has(name))
      : [...previousRequired].filter((name) => !nextRequired.has(name));
  for (const name of changedRequired) {
    issues.push(`${path} ${variance === "input" ? "added" : "removed"} required property ${name}`);
  }
  if (objectContract) {
    issues.push(...additionalPropertiesIssues(previous, next, path, variance));
  }

  const previousItems = record(previous.items);
  const nextItems = record(next.items);
  if (previousItems && nextItems) {
    issues.push(...schemaCompatibilityIssues(previousItems, nextItems, `${path}[]`, variance));
  } else if (!schemaValueEqual(previous.items, next.items)) {
    const safeBooleanChange =
      (variance === "input" && previous.items === false && next.items === true) ||
      (variance === "output" && previous.items === true && next.items === false);
    if (!safeBooleanChange) issues.push(`${path} changed items incompatibly`);
  }

  return issues;
}

function requestCompatibilityIssues(
  operationId: string,
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined
): string[] {
  if (!previous) {
    if (!next) return [];
    return [...schemaRequired(next)].map(
      (name) => `operations: ${operationId} request added required property ${name}`
    );
  }
  if (!next) return [`operations: ${operationId} request schema was removed`];
  return schemaCompatibilityIssues(previous, next, "request", "input").map(
    (issue) => `operations: ${operationId} ${issue}`
  );
}

type OimHttpSource = Extract<OimOperation["source"], { type: "http" }>;
type OimHttpParameter = NonNullable<OimHttpSource["parameters"]>[number];

function agentHttpParameters(source: OimHttpSource): Map<string, OimHttpParameter> {
  return new Map(
    (source.parameters ?? [])
      .filter(
        (parameter) => parameter.value === undefined && parameter.configurationField === undefined
      )
      .map((parameter) => [`${parameter.in}:${parameter.name}`, parameter])
  );
}

function httpParameterRequired(parameter: OimHttpParameter): boolean {
  return parameter.in === "path" || parameter.required === true;
}

function httpSourceCompatibilityIssues(
  operationId: string,
  previous: OimHttpSource,
  next: OimHttpSource
): string[] {
  const previousParameters = agentHttpParameters(previous);
  const nextParameters = agentHttpParameters(next);
  const issues: string[] = [];
  for (const [key, parameter] of previousParameters) {
    const candidate = nextParameters.get(key);
    if (!candidate) {
      issues.push(
        `operations: ${operationId} HTTP parameter ${parameter.in} ${parameter.name} was removed or became bound`
      );
      continue;
    }
    if (!httpParameterRequired(parameter) && httpParameterRequired(candidate)) {
      issues.push(
        `operations: ${operationId} HTTP parameter ${parameter.in} ${parameter.name} became required`
      );
    }
    issues.push(
      ...schemaCompatibilityIssues(
        parameter.schema,
        candidate.schema,
        `HTTP parameter ${parameter.in} ${parameter.name}`,
        "input"
      ).map((issue) => `operations: ${operationId} ${issue}`)
    );
  }
  for (const [key, parameter] of nextParameters) {
    if (!previousParameters.has(key) && httpParameterRequired(parameter)) {
      issues.push(
        `operations: ${operationId} HTTP parameter ${parameter.in} ${parameter.name} added required input`
      );
    }
  }
  return issues;
}

function responseCompatibilityIssues(
  operationId: string,
  previous: Record<string, unknown>,
  next: Record<string, unknown>
): string[] {
  return schemaCompatibilityIssues(previous, next, "response", "output").map(
    (issue) => `operations: ${operationId} ${issue}`
  );
}

function authCompatibilityIssues(previous: OimManifest, next: OimManifest): string[] {
  if (!previous.auth) {
    if (!next.auth) return [];
    return [
      ...next.auth.credentialSlots
        .filter((slot) => slot.required !== false)
        .map((slot) => `auth: added required credential slot ${slot.id}`),
      ...(next.auth.configurationFields ?? [])
        .filter((field) => field.required === true)
        .map((field) => `auth: added required configuration field ${field.id}`),
    ];
  }
  if (!next.auth) return ["auth: declaration was removed"];

  const issues: string[] = [];
  const nextSlots = new Map(next.auth.credentialSlots.map((slot) => [slot.id, slot]));
  for (const slot of previous.auth.credentialSlots) {
    const candidate = nextSlots.get(slot.id);
    if (!candidate) {
      issues.push(`auth: credential slot ${slot.id} was removed`);
    } else if (candidate.kind !== slot.kind) {
      issues.push(`auth: credential slot ${slot.id} changed kind`);
    } else if (slot.required === false && candidate.required !== false) {
      issues.push(`auth: credential slot ${slot.id} became required`);
    }
  }
  const previousSlots = new Set(previous.auth.credentialSlots.map((slot) => slot.id));
  for (const slot of next.auth.credentialSlots) {
    if (!previousSlots.has(slot.id) && slot.required !== false) {
      issues.push(`auth: added required credential slot ${slot.id}`);
    }
  }

  const nextFields = new Map(
    (next.auth.configurationFields ?? []).map((field) => [field.id, field])
  );
  for (const field of previous.auth.configurationFields ?? []) {
    const candidate = nextFields.get(field.id);
    if (!candidate) {
      issues.push(`auth: configuration field ${field.id} was removed`);
    } else if (candidate.type !== field.type) {
      issues.push(`auth: configuration field ${field.id} changed type`);
    } else {
      if (field.required !== true && candidate.required === true) {
        issues.push(`auth: configuration field ${field.id} became required`);
      }
      if (field.agentVisible === true && candidate.agentVisible !== true) {
        issues.push(`auth: configuration field ${field.id} stopped being agent-visible`);
      }
    }
  }
  const previousFields = new Set(
    (previous.auth.configurationFields ?? []).map((field) => field.id)
  );
  for (const field of next.auth.configurationFields ?? []) {
    if (!previousFields.has(field.id) && field.required === true) {
      issues.push(`auth: added required configuration field ${field.id}`);
    }
  }

  const nextSteps = new Map(next.auth.steps.map((step) => [step.id, step]));
  for (const step of previous.auth.steps) {
    const candidate = nextSteps.get(step.id);
    if (!candidate) {
      issues.push(`auth: step ${step.id} was removed`);
    } else if (candidate.type !== step.type) {
      issues.push(`auth: step ${step.id} changed type`);
    } else {
      const {
        title: _previousTitle,
        description: _previousDescription,
        ...previousContract
      } = step;
      const { title: _nextTitle, description: _nextDescription, ...nextContract } = candidate;
      if (!schemaValueEqual(previousContract, nextContract)) {
        issues.push(`auth: step ${step.id} changed credential mapping`);
      }
    }
  }
  return issues;
}

/**
 * Conservative same-major compatibility check. New optional object properties are allowed; an
 * existing operation, accepted input, or stable output cannot disappear or change type.
 */
export function oimCompatibilityIssues(previous: OimManifest, next: OimManifest): string[] {
  const previousMajor = versionMajor(previous.metadata.version);
  if (versionMajor(next.metadata.version) !== previousMajor) {
    return [
      `metadata.version: compatibility can only be checked within major version ${previousMajor}`,
    ];
  }

  const issues: string[] = [];
  if (next.metadata.id !== previous.metadata.id) {
    issues.push(`metadata.id: ${previous.metadata.id} changed to ${next.metadata.id}`);
  }
  issues.push(...authCompatibilityIssues(previous, next));

  const nextOperations = new Map(next.operations.map((operation) => [operation.id, operation]));
  for (const operation of previous.operations) {
    const candidate = nextOperations.get(operation.id);
    if (!candidate) {
      issues.push(`operations: ${operation.id} was removed`);
      continue;
    }

    for (const field of ["name", "effect", "identityMode", "credentialSlot"] as const) {
      if (candidate[field] !== operation[field]) {
        issues.push(`operations: ${operation.id} changed ${field}`);
      }
    }
    if (!schemaValueEqual(candidate.credentialInjection, operation.credentialInjection)) {
      issues.push(`operations: ${operation.id} changed credentialInjection`);
    }
    if (!schemaValueEqual(candidate.secondaryCredential, operation.secondaryCredential)) {
      issues.push(`operations: ${operation.id} changed secondaryCredential`);
    }
    if (candidate.source.type !== operation.source.type) {
      issues.push(`operations: ${operation.id} changed source type`);
    } else if (candidate.source.type === "http" && operation.source.type === "http") {
      issues.push(
        ...httpSourceCompatibilityIssues(operation.id, operation.source, candidate.source)
      );
    }

    issues.push(
      ...requestCompatibilityIssues(operation.id, operation.requestSchema, candidate.requestSchema),
      ...(operation.response.mode === "binary" || candidate.response.mode === "binary"
        ? operation.response.mode === candidate.response.mode
          ? []
          : [`operations: ${operation.id} changed response mode`]
        : responseCompatibilityIssues(
            operation.id,
            operation.response.schema,
            candidate.response.schema
          ))
    );

    const previousProjection =
      operation.response.mode === "binary" ? undefined : operation.response.projection;
    const nextProjection =
      candidate.response.mode === "binary" ? undefined : candidate.response.projection;
    if (!previousProjection && nextProjection) {
      issues.push(`operations: ${operation.id} response projection became narrower`);
    } else if (previousProjection) {
      const projected = new Set(nextProjection ?? []);
      for (const pointer of previousProjection) {
        if (!projected.has(pointer)) {
          issues.push(`operations: ${operation.id} response projection removed ${pointer}`);
        }
      }
    }
    if (candidate.response.maxBytes < operation.response.maxBytes) {
      issues.push(`operations: ${operation.id} response maxBytes was reduced`);
    }
  }
  return issues;
}

/** Cases missing from a runtime's claimed OIM profiles. */
export function oimConformanceIssues(
  claim: Omit<OimConformanceClaim, "passedCases"> & { passedCases: readonly string[] }
): string[] {
  const passed = new Set(claim.passedCases);
  const issues: string[] = [];
  for (const profile of Object.keys(OIM_CONFORMANCE_CASES) as Array<
    keyof typeof OIM_CONFORMANCE_CASES
  >) {
    if (claim.profiles[profile] === undefined) continue;
    for (const required of OIM_CONFORMANCE_CASES[profile]) {
      if (!passed.has(required)) issues.push(`passedCases: missing ${required}`);
    }
  }
  return issues;
}

/** Stable Tool identity that permits side-by-side Integration major versions. */
export function oimToolId(manifest: OimManifest, operationId: string): string {
  if (!manifest.operations.some((operation) => operation.id === operationId)) {
    throw new TulipFarmValidationError(
      "integration",
      "/operations",
      `unknown OIM operation ${operationId}`
    );
  }
  const major = versionMajor(manifest.metadata.version);
  return `oim.${manifest.metadata.id}.v${major}.${operationId}`;
}
