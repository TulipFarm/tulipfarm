import { z } from 'zod';
import { sourceDependencySchema, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import type { IntegrationKeyring } from '@tulipfarm/integrations';
import type { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export const mcpLimits = {
  integrations: 20,
  selectedTools: 100,
  discoveredTools: 200,
  discoveryPages: 20,
  argumentBytes: 128 * 1024,
  responseBytes: 2 * 1024 * 1024,
  catalogBytes: 4 * 1024 * 1024,
  discoveryMs: 60_000,
  callMs: 30_000,
  approvalMs: 24 * 60 * 60 * 1000,
  jsonDepth: 32,
  schemaNodes: 2000,
  schemaBytes: 64 * 1024,
};
export const workspaceMcpCompatibility = commonCompatibility;
export const mcpCompatibilityProfile = {
  transports: ['streamable-http', 'sse'],
  protocolVersions: ['2025-03-26', '2025-06-18', '2025-11-25'],
  legacyProtocolVersions: ['2024-11-05'],
  schemaDialect: 'http://json-schema.org/draft-07/schema#',
  // MCP's default dialect. The allowed keywords mean the same in both, since array-form `items` is refused.
  rootSchemaDialects: ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema'],
  unsupportedSchemaKeywords: [
    '$ref',
    '$dynamicRef',
    '$recursiveRef',
    'pattern',
    'patternProperties',
    'format',
    'uniqueItems',
    'contains',
  ],
};
export class McpError extends Error {
  constructor(
    readonly code:
      | 'disabled'
      | 'conflict'
      | 'limit'
      | 'invalid-input'
      | 'incompatible-tool'
      | 'credential-unavailable'
      | 'discovery-failed'
      | 'integration-unavailable'
      | 'approval-required'
      | 'expired'
      | 'integration-blocked'
      | 'outcome-unknown'
      | 'oauth-conflict'
      | 'secret-denied'
      | 'install-failed',
    options?: ErrorOptions,
  ) {
    super(`Workspace MCP ${code}`, options);
    this.name = 'McpError';
  }
}
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export const jsonObjectSchema = z.record(z.string(), z.json());
export const mcpSourceDependencySchema = z.strictObject({
  kind: z.literal('mcp-integration'),
  integrationId: z.uuid(),
  authorizationEpoch: z.number().int().positive(),
});
export const mcpSourcesSchema = z
  .array(
    z.union([
      mcpSourceDependencySchema,
      z.strictObject({ kind: z.literal('private-task'), taskId: z.uuid() }),
      sourceDependencySchema,
    ]),
  )
  .max(1000);
export type McpSourceDependency = z.infer<typeof mcpSourcesSchema>[number];
export const mcpOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('private-chat'), conversationId: z.uuid(), turnId: z.uuid(), stepId: z.uuid() }),
  z.strictObject({ kind: z.literal('named-task'), taskId: z.uuid(), stepId: z.uuid() }),
]);
export type McpOrigin = z.infer<typeof mcpOriginSchema>;
export const mcpSelectionSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('chat'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('task'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('task-draft'), id: z.uuid(), agentId: z.uuid() }),
]);
export type McpSelectionSubject = z.infer<typeof mcpSelectionSubjectSchema>;
export type McpSelectionAuthority = {
  sources: McpSourceDependency[];
  slots: null | Array<{
    slotId: string;
    serverIdentity: string;
    integrationId?: string;
    tools: Array<{ name: string; revision: string }>;
  }>;
};
const npmName = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const pypiName = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const semver =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const pep440 = /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9]+(?:\.[a-z0-9]+)*)?$/;
/** PyPI compares names after lowercasing and folding runs of `-`, `_` and `.` into one `-`. */
export const normalizePackageName = (registry: 'npm' | 'pypi', name: string) =>
  registry === 'pypi' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name;
/** An npm or PyPI MCP server package at one exact version. Arguments are not secret. */
export const mcpPackageSchema = z
  .strictObject({
    registry: z.enum(['npm', 'pypi']),
    name: z.string().min(1).max(214),
    version: z.string().min(1).max(128),
    arguments: z
      .array(
        z
          .string()
          .max(512)
          .regex(/^[^\0]*$/),
      )
      .max(16)
      .optional(),
  })
  .refine(value =>
    value.registry === 'npm'
      ? npmName.test(value.name) && semver.test(value.version)
      : pypiName.test(normalizePackageName('pypi', value.name)) && pep440.test(value.version),
  );
export type McpPackage = z.infer<typeof mcpPackageSchema>;
/** The stable key of a package, without its version. A hosted integration's server identity is its digest. */
export const packageKey = (value: Pick<McpPackage, 'registry' | 'name'>) => `${value.registry}:${value.name}`;
const reservedEnv =
  /^(PATH|HOME|PORT|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|LD_.*|SSL_.*|.*_PROXY|NPM_CONFIG_.*|PIP_.*|UV_.*|SUPERGATEWAY_.*|MCP_BRIDGE_.*)$/;
const envName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
  .refine(name => !reservedEnv.test(name));
export const mcpHostedEnvSchema = z
  .array(
    z.union([
      z.strictObject({
        name: envName,
        value: z
          .string()
          .regex(/^[^\0]*$/)
          .refine(value => Buffer.byteLength(value) <= 4096),
      }),
      z.strictObject({ name: envName, secretId: z.uuid(), reveal: z.boolean().optional() }),
    ]),
  )
  .max(20)
  .refine(env => new Set(env.map(entry => entry.name)).size === env.length)
  .refine(env => env.filter(entry => 'secretId' in entry).length <= 20);
export type McpHostedEnv = z.infer<typeof mcpHostedEnvSchema>;
/** Hosts a hosted integration may reach besides its secrets' own hosts. */
export const mcpEgressSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(253)
      .regex(/^(?=.*[a-z])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/),
  )
  .max(20)
  .refine(hosts => new Set(hosts).size === hosts.length);
export const mcpCredentialSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('bearer'),
    token: z
      .string()
      .min(1)
      .max(16384)
      .regex(/^[^\r\n\0]+$/),
  }),
  z.strictObject({
    kind: z.literal('headers'),
    headers: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/), z.string().min(1).max(16384))
      .refine(
        headers =>
          Object.keys(headers).length > 0 &&
          Object.keys(headers).length <= 10 &&
          Object.entries(headers).every(
            ([key, value]) =>
              !/^(host|cookie|set-cookie|integration|content-length|transfer-encoding|proxy-.*|forwarded|x-forwarded-.*|accept|content-type|mcp-.*)$/i.test(
                key,
              ) && !/[\r\n\0]/.test(value),
          ),
      ),
  }),
  z.strictObject({
    kind: z.literal('oauth'),
    accessToken: z.string().min(1).max(16384),
    refreshToken: z.string().min(1).max(16384).nullable(),
    expiresAt: z.iso.datetime(),
    issuer: z.url().max(2048),
    resource: z.url().max(2048),
    clientId: z.string().min(1).max(2048),
    clientSecret: z.string().min(1).max(16384).optional(),
    authMethod: z.enum(['none', 'client_secret_basic', 'client_secret_post']),
    scopes: z.array(z.string().max(256)).max(512),
    accountId: z.string().max(512).nullable(),
  }),
  z.strictObject({ kind: z.literal('hosted'), env: mcpHostedEnvSchema }),
  z.strictObject({ kind: z.literal('secret-bearer'), secretId: z.uuid() }),
  z.strictObject({
    kind: z.literal('secret-headers'),
    secretIds: z
      .array(z.uuid())
      .min(1)
      .max(10)
      .refine(ids => new Set(ids).size === ids.length),
  }),
]);
export type McpCredential = z.infer<typeof mcpCredentialSchema>;
export type McpSecretCredential = Extract<McpCredential, { kind: 'secret-bearer' | 'secret-headers' }>;
export type McpHostedCredential = Extract<McpCredential, { kind: 'hosted' }>;
export type McpHostedBinding = { name: string; secretId: string; reveal: boolean };
export const hostedBindings = (credential: McpHostedCredential): McpHostedBinding[] =>
  credential.env.flatMap(entry =>
    'secretId' in entry ? [{ name: entry.name, secretId: entry.secretId, reveal: entry.reveal === true }] : [],
  );
export const isSecretCredential = (credential: McpCredential): credential is McpSecretCredential =>
  credential.kind === 'secret-bearer' || credential.kind === 'secret-headers';
export const secretIdsOf = (credential: McpSecretCredential) =>
  credential.kind === 'secret-bearer' ? [credential.secretId] : credential.secretIds;
/** What the transport sends: a stored credential, or the bearer token or headers resolved from saved secrets. */
export type McpSendCredential =
  | Exclude<McpCredential, McpSecretCredential | McpHostedCredential>
  | { kind: 'headers'; headers: Record<string, string>; cookie?: string };
export type McpSecretVersion = { secretId: string; version: number; policyVersion: number };
/** Who can use an integration. `workspace` means every current and future member. */
export type McpSecretUsers = { membershipIds: string[]; teamIds: string[]; workspace?: boolean };
/**
 * Saved secrets an integration authenticates with. `bind` reads policy only and may run in the API; `resolve` and
 * `recordUse` decrypt or record sends and are given only in the worker.
 */
export type McpSecretsPort = {
  bind(
    tx: AuthorizationTransaction,
    input: { credential: McpSecretCredential; endpoint: string; users: McpSecretUsers },
  ): Promise<McpSecretVersion[]>;
  resolve?: (
    tx: AuthorizationTransaction,
    input: {
      workspaceId: string;
      membershipId: string;
      credential: McpSecretCredential;
      endpoint: string;
      expected?: McpSecretVersion[];
    },
  ) => Promise<{ credential: McpSendCredential; secrets: McpSecretVersion[]; values: string[] }>;
  recordUse?: (
    tx: AuthorizationTransaction,
    input: { secretIds: string[]; membershipId: string; endpoint: string; tool: string },
  ) => Promise<void>;
};
/** Where a host writes a protected secret into the package's requests to the secret's own hosts. */
export type McpHostPlacement = { kind: 'bearer' } | { kind: 'basic' } | { kind: 'header'; name: string };
/** A saved secret a hosted integration names, read for one member. `value` is present only in the worker. */
export type McpHostedSecret = McpSecretVersion & {
  secretId: string;
  /** The secret's host destinations. */
  hosts: string[];
  /** Null for a revealed secret, whose placement does not matter. */
  placement: McpHostPlacement | null;
};
export type McpHostedSecretsPort = {
  /**
   * Checks, without decrypting, that every member and team in `users` may send each secret, that each protected
   * secret has a bearer, basic or header placement and a host destination, and that each revealed secret's owner
   * allowed `serverIdentity` to read it.
   */
  bind(
    tx: AuthorizationTransaction,
    input: { bindings: McpHostedBinding[]; serverIdentity: string; users: McpSecretUsers },
  ): Promise<McpHostedSecret[]>;
  /** Decrypts the secrets for one member, failing when any was replaced since `expected`. Worker only. */
  resolve?: (
    tx: AuthorizationTransaction,
    input: {
      workspaceId: string;
      membershipId: string;
      bindings: McpHostedBinding[];
      serverIdentity: string;
      expected?: McpSecretVersion[];
    },
  ) => Promise<Array<McpHostedSecret & { value: string; parts: string[] }>>;
};
export type McpHostLaunch = {
  workspaceId: string;
  integrationId: string;
  generation: number;
  fingerprint: string;
  package: McpPackage;
  /** Plain settings and revealed values. Present only in the worker. */
  env: Record<string, string>;
  protectedSecrets: Array<{ variable: string; value: string; hosts: string[]; placement: McpHostPlacement }>;
  egress: string[];
};
/** Runs hosted MCP packages, one sandbox per integration. Supplied by an extension; absent means hosting is off. */
export type McpHostPort = {
  /** Builds if needed, then creates or wakes the sandbox for this generation and waits until healthy. */
  provision(input: McpHostLaunch, signal: AbortSignal): Promise<{ sandboxId: string }>;
  /** A URL and headers that reach the running sandbox's MCP port for a short time. */
  connect(
    input: { sandboxId: string },
    signal: AbortSignal,
  ): Promise<{ endpoint: string; headers: Record<string, string> }>;
  /** Deletes the sandbox only if it still has this id and generation. */
  remove(
    input: { workspaceId: string; integrationId: string; sandboxId: string; generation: number },
    signal: AbortSignal,
  ): Promise<void>;
  list(
    signal: AbortSignal,
  ): AsyncIterable<{ workspaceId: string; integrationId: string; sandboxId: string; generation: number }>;
};
/** The running sandbox a hosted integration's requests go to, instead of its synthetic endpoint. */
export type McpHostTarget = { endpoint: string; headers: Record<string, string> };
/** How a remote integration's server is reached; the older HTTP+SSE transport is detected when discovery falls back. */
export const mcpTransportSchema = z.enum(['streamable-http', 'sse']);
export type McpTransport = z.infer<typeof mcpTransportSchema>;
export const secretVersionsSchema = z
  .array(
    z.strictObject({
      secretId: z.uuid(),
      version: z.number().int().positive(),
      policyVersion: z.number().int().positive(),
    }),
  )
  .max(20);
export const mcpToolSchema = z.strictObject({
  name: z.string().min(1).max(256),
  description: z.string().max(32768),
  inputSchema: jsonObjectSchema,
  outputSchema: jsonObjectSchema.optional(),
  annotations: jsonObjectSchema.optional(),
  execution: jsonObjectSchema.optional(),
});
export type McpTool = z.infer<typeof mcpToolSchema>;
export const mcpResultSchema = z.strictObject({
  content: z.array(z.strictObject({ type: z.literal('text'), text: z.string() })).max(1000),
  structuredContent: jsonObjectSchema.optional(),
  isError: z.boolean().optional(),
});
export type McpResult = z.infer<typeof mcpResultSchema>;
export type ProtocolContext = {
  endpoint: string;
  credential: McpSendCredential;
  signal: AbortSignal;
  /** Set only for a hosted integration: the sandbox URL and headers that replace `endpoint`. */
  hostTarget?: McpHostTarget;
  /** The transport the last discovery detected; discovery itself always detects it again. */
  transport?: McpTransport;
};
export type McpProtocolPort = {
  discover(input: ProtocolContext): Promise<{ tools: McpTool[]; transport?: McpTransport }>;
  call(
    input: ProtocolContext & {
      tool: McpTool;
      arguments: JsonObject;
      requestId: string;
      deadline: number;
      authorize: () => Promise<void>;
    },
  ): Promise<McpResult>;
};
export type OriginAuthorization = {
  sources: McpSourceDependency[];
  allowedTools: null | Array<{
    serverIdentity: string;
    name: string;
    revision: string;
    integrationId?: string;
    slotId?: string;
  }>;
};
export type McpPhase = 'select' | 'catalog' | 'propose' | 'approve' | 'dispatch' | 'read';
export type McpPrincipal = string | HumanActor;
export type McpRuntime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
export type WorkspaceMcpOptions = {
  runtime: McpRuntime;
  keyring: IntegrationKeyring;
  protocol: McpProtocolPort;
  authorizeOrigin(input: {
    transaction: AuthorizationTransaction;
    actor: HumanActor;
    origin: McpOrigin;
    phase: McpPhase;
  }): Promise<OriginAuthorization>;
  authorizeSources(input: {
    transaction: AuthorizationTransaction;
    actor: HumanActor;
    sources: McpSourceDependency[];
  }): Promise<void>;
  authorizeSelection?: (input: {
    transaction: AuthorizationTransaction;
    actor: HumanActor;
    subject: McpSelectionSubject;
  }) => Promise<McpSelectionAuthority>;
  resolveConfirmationCredential?: (workspaceId: string) => Promise<string>;
  secrets?: McpSecretsPort;
  hostedSecrets?: McpHostedSecretsPort;
  /** The sandbox host. Only the worker has one; without it hosted integrations cannot be discovered or called. */
  host?: McpHostPort;
  /** Whether new hosted integrations may be set up in a workspace. Defaults to false. */
  hostedEnabled?: (workspaceId: string) => boolean | Promise<boolean>;
  admissionEnabled?: boolean;
  dispatchEnabled?: boolean;
};
export const integrationRowSchema = z.object({
  id: z.uuid(),
  ownership: z.enum(['personal', 'shared']),
  owner_membership_id: z.uuid().nullable(),
  name: z.string(),
  endpoint: z.string(),
  server_identity: z.string(),
  lifecycle: z.enum(['active', 'disabled', 'disconnected', 'deleted', 'authorizing', 'reconnect-required']),
  authorization_epoch: z.number().int(),
  secret_version: z.number().int(),
  grants_version: z.number().int(),
  credential: z.unknown(),
  refresh_claim: z.uuid().nullable(),
  refresh_started_at: z.date().nullable(),
  descriptor_approved: z.boolean(),
  version: z.number().int(),
  auth_method: z.enum(['none', 'bearer', 'headers', 'oauth', 'secret-bearer', 'secret-headers', 'hosted']),
  credential_expires_at: z.date().nullable(),
  discovery: z.enum(['queued', 'failed']).nullable(),
  status_reason: z.string().nullable(),
  kind: z.enum(['remote', 'hosted']).default('remote'),
  package: mcpPackageSchema.nullable().default(null),
  egress: z.array(z.string()).nullable().default(null),
  transport: mcpTransportSchema.nullable().default(null),
  shared_with_workspace: z.boolean().default(false),
});
export const integrationMetadataSchema = z.object({
  id: z.uuid(),
  ownership: z.enum(['personal', 'shared']),
  name: z.string(),
  endpoint: z.string(),
  serverIdentity: z.string(),
  descriptorApproved: z.boolean(),
  lifecycle: integrationRowSchema.shape.lifecycle,
  authorizationEpoch: z.number().int(),
  secretVersion: z.number().int(),
  grantsVersion: z.number().int(),
  version: z.number().int(),
  authMethod: integrationRowSchema.shape.auth_method,
  refreshDue: z.boolean(),
  discovery: integrationRowSchema.shape.discovery,
  statusReason: z.string().nullable(),
  kind: integrationRowSchema.shape.kind,
  package: mcpPackageSchema.nullable(),
  egress: z.array(z.string()).nullable(),
  blocked: z.boolean(),
  barrierActionId: z.uuid().nullable(),
  capabilities: z.object({ read: z.boolean(), manage: z.boolean(), use: z.boolean() }),
});
export type IntegrationRow = z.infer<typeof integrationRowSchema>;
export const actionRowSchema = z.object({
  id: z.uuid(),
  requester: z.strictObject({ kind: z.literal('human'), userId: z.string(), membershipId: z.uuid() }),
  origin: mcpOriginSchema,
  integration_id: z.uuid(),
  authorization_epoch: z.number().int(),
  selection_version: z.number().int(),
  tool_name: z.string(),
  tool_revision: z.string(),
  policy_version: z.number().int(),
  arguments: jsonObjectSchema,
  sources: mcpSourcesSchema,
  digest: z.string(),
  requires_consent: z.boolean(),
  secrets: secretVersionsSchema,
  created_at: z.date(),
  expires_at: z.date(),
});
export type ActionRow = z.infer<typeof actionRowSchema>;
