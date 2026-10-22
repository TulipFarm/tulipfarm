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
  transport: 'streamable-http',
  protocolVersions: ['2025-03-26', '2025-06-18', '2025-11-25'],
  schemaDialect: 'http://json-schema.org/draft-07/schema#',
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
      | 'oauth-conflict',
  ) {
    super(`Workspace MCP ${code}`);
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
    scopes: z.array(z.string().max(256)).max(100),
    accountId: z.string().max(512).nullable(),
  }),
]);
export type McpCredential = z.infer<typeof mcpCredentialSchema>;
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
export type ProtocolContext = { endpoint: string; credential: McpCredential; signal: AbortSignal };
export type McpProtocolPort = {
  discover(input: ProtocolContext): Promise<{ tools: McpTool[] }>;
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
  auth_method: z.enum(['none', 'bearer', 'headers', 'oauth']),
  credential_expires_at: z.date().nullable(),
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
  created_at: z.date(),
  expires_at: z.date(),
});
export type ActionRow = z.infer<typeof actionRowSchema>;
