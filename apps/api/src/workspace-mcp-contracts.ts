import { z } from 'zod';
import { mcpHttpId } from './workspace-mcp-http.ts';

const version = z.number().int().nonnegative();
const revision = z.string().min(1).max(512);
const time = z.iso.datetime({ offset: true });
export const mcpCapabilitiesSchema = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    canManageShared: z.boolean(),
    integrationsEnabled: z.boolean(),
    dispatchEnabled: z.boolean(),
  }),
]);
export const mcpCatalogSchema = z.strictObject({
  source: z.literal('Official MCP Registry'),
  snapshotVersion: z.string(),
  syncedAt: time.nullable(),
  stale: z.boolean(),
  nextCursor: z.string().nullable(),
  entries: z
    .array(
      z.strictObject({
        id: revision,
        name: z.string(),
        description: z.string(),
        version: z.string(),
        endpoint: z.string(),
        compatibility: z.enum(['eligible', 'unknown', 'unsupported']),
        reason: z.string().nullable(),
        authentication: z.enum(['none', 'headers', 'bearer', 'oauth', 'unknown']),
      }),
    )
    .max(100),
});
export const mcpCatalogQuery = z.strictObject({
  search: z.string().trim().max(200).default(''),
  cursor: z.string().max(512).optional(),
});
export const mcpIntegrationSchema = z.strictObject({
  id: mcpHttpId,
  name: z.string(),
  ownership: z.enum(['personal', 'shared']),
  endpoint: z.string(),
  accountLabel: z.string().nullable(),
  authMethod: z.enum(['none', 'headers', 'bearer', 'oauth']),
  status: z.enum([
    'setup',
    'oauth-pending',
    'registration-required',
    'discovering',
    'review-required',
    'ready',
    'disabled',
    'disconnected',
    'error',
  ]),
  version,
  authorizationEpoch: version,
  canManage: z.boolean(),
  canUse: z.boolean(),
  barrier: z.strictObject({ actionId: mcpHttpId }).nullable(),
  statusReason: z.string().nullable(),
  reauthorizationRequired: z.boolean().optional(),
});
export const mcpGrantSchema = z.strictObject({ kind: z.enum(['member', 'team']), id: mcpHttpId });
export const mcpToolViewSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  revision,
  previousRevision: revision.nullable(),
  inputSchema: z.json(),
  outputSchema: z.json().nullable(),
  compatibility: z.enum(['compatible', 'unsupported']),
  reason: z.string().nullable(),
  review: z.enum(['new', 'reviewed', 'changed']),
  enabled: z.boolean(),
  standingException: z.boolean(),
});
export const mcpIntegrationDetailSchema = z.strictObject({
  integration: mcpIntegrationSchema,
  tools: z.array(mcpToolViewSchema).max(200),
  grants: z.array(mcpGrantSchema),
  managers: z.array(mcpGrantSchema),
  grantOptions: z.array(mcpGrantSchema.extend({ label: z.string() })),
  descriptor: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('chat-only'), reason: z.string() }),
    z.strictObject({ kind: z.literal('reviewable'), id: revision, label: z.string(), identity: z.string() }),
    z.strictObject({ kind: z.literal('approved'), id: revision, label: z.string(), identity: z.string() }),
  ]),
});
export const mcpAuthenticationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('bearer'), token: z.string().min(1).max(16384) }),
  z.strictObject({
    kind: z.literal('headers'),
    headers: z
      .array(
        z.strictObject({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/), value: z.string().min(1).max(16384) }),
      )
      .min(1)
      .max(10),
  }),
  z.strictObject({
    kind: z.literal('oauth'),
    client: z
      .strictObject({
        clientId: z.string().min(1).max(2048),
        clientSecret: z.string().min(1).max(16384).optional(),
        authMethod: z.enum(['none', 'client_secret_basic', 'client_secret_post']),
      })
      .optional(),
  }),
]);
export const mcpSetupSchema = z.strictObject({
  requestId: mcpHttpId,
  name: z.string().trim().min(1).max(120),
  endpoint: z.url().max(2048),
  ownership: z.enum(['personal', 'shared']),
  catalogEntryId: revision.optional(),
  auth: mcpAuthenticationSchema,
  expectedVersion: version.optional(),
});
export const mcpSetupResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('saved'), integration: mcpIntegrationSchema }),
  z.strictObject({ kind: z.literal('oauth'), integration: mcpIntegrationSchema, authorizationUrl: z.url() }),
  z.strictObject({
    kind: z.literal('registration-required'),
    integration: mcpIntegrationSchema,
    registration: z.strictObject({ instructions: z.string(), redirectUri: z.url(), clientMetadataUrl: z.url() }),
  }),
]);
export const mcpMutationSchema = z.strictObject({ requestId: mcpHttpId, expectedVersion: version });
export const mcpDescriptorSchema = mcpMutationSchema.extend({ serverIdentity: z.string().regex(/^[a-f0-9]{64}$/) });
export const mcpReviewSchema = mcpMutationSchema.extend({
  tools: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(256),
        revision,
        enabled: z.boolean(),
        standingException: z.boolean(),
      }),
    )
    .max(200),
});
export const mcpGrantsSchema = mcpMutationSchema.extend({
  grants: z.array(mcpGrantSchema).max(200),
  managers: z.array(mcpGrantSchema).max(200).optional(),
});
export const mcpLifecycleSchema = mcpMutationSchema.extend({
  operation: z.enum(['enable', 'disable', 'disconnect', 'delete']),
});
export const mcpBindingSchema = z.strictObject({ integrationId: mcpHttpId, slotId: revision.nullable() });
export const mcpSelectionSchema = z.strictObject({
  id: mcpHttpId,
  version,
  bindings: z.array(mcpBindingSchema),
  stale: z.boolean(),
  choices: z.array(
    z.strictObject({
      integration: mcpIntegrationSchema,
      slotId: revision.nullable(),
      slotLabel: z.string().nullable(),
      unavailableReason: z.string().nullable(),
    }),
  ),
});
export const mcpSelectionParams = z.strictObject({
  workspaceId: mcpHttpId,
  kind: z.enum(['chat', 'task', 'task-draft']),
  originId: mcpHttpId,
});
export const mcpSelectionQuery = z.strictObject({ agentId: mcpHttpId.optional() });
export const mcpSelectionInput = mcpMutationSchema.extend({
  bindings: z.array(mcpBindingSchema).max(20),
  agentId: mcpHttpId.optional(),
});
export const mcpPermissionSlotSchema = z.strictObject({
  slotId: revision,
  serverIdentity: revision,
  label: z.string().max(120),
  binding: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('personal') }),
    z.strictObject({ kind: z.literal('shared'), integrationId: mcpHttpId }),
  ]),
  tools: z.array(z.strictObject({ name: z.string().min(1).max(256), revision })).max(100),
});
export const mcpPermissionsSchema = z.strictObject({
  savedRevision: revision,
  activeRevision: revision.nullable(),
  canEdit: z.boolean(),
  slots: z.array(mcpPermissionSlotSchema),
  choices: z.array(mcpPermissionSlotSchema),
});
export const mcpPermissionInput = z.strictObject({
  requestId: mcpHttpId,
  expectedSavedRevision: revision,
  slots: z.array(mcpPermissionSlotSchema).max(20),
});
const actionBase = {
  id: mcpHttpId,
  digest: revision,
  integrationId: mcpHttpId,
  integrationName: z.string(),
  status: z.enum([
    'awaiting-approval',
    'ready',
    'dispatched',
    'succeeded',
    'rejected',
    'cancelled',
    'expired',
    'invalidated',
    'outcome-unknown',
  ]),
  expiresAt: time,
  canDecide: z.boolean(),
  canReconcile: z.boolean(),
  integrationPaused: z.boolean(),
  reconciliation: z
    .strictObject({
      outcome: z.enum(['completed', 'not-performed', 'still-unknown']),
      notes: z.string(),
      observedAt: time,
      observer: z.string(),
      administrative: z.boolean(),
    })
    .nullable(),
  receipt: z
    .strictObject({
      dispatchedAt: time.nullable(),
      receivedAt: time.nullable(),
      outcome: z.enum(['succeeded', 'unknown', 'not-dispatched']),
      text: z.string().nullable(),
      structured: z.json().nullable(),
    })
    .nullable(),
};
export const mcpActionSchema = z.discriminatedUnion('visibility', [
  z.strictObject({
    ...actionBase,
    visibility: z.literal('full'),
    exact: z.strictObject({
      origin: z.strictObject({ kind: z.enum(['chat', 'task']), id: mcpHttpId }),
      requester: z.string(),
      endpoint: z.string(),
      accountLabel: z.string().nullable(),
      authorizationEpoch: version,
      toolName: z.string(),
      toolRevision: revision,
      arguments: z.json(),
      sourceLabels: z.array(z.string()),
      outboundConsentRequired: z.boolean(),
      standingExceptionApplied: z.boolean(),
    }),
  }),
  z.strictObject({
    ...actionBase,
    visibility: z.literal('requester-metadata'),
    canDecide: z.literal(false),
    receipt: z.null(),
    reconciliation: actionBase.reconciliation
      .unwrap()
      .extend({ notes: z.literal('') })
      .nullable(),
  }),
]);
export const mcpActionQuery = z.strictObject({
  kind: z.enum(['chat', 'task', 'integration']),
  originId: mcpHttpId,
  cursor: mcpHttpId.optional(),
});
export const mcpActionListSchema = z.strictObject({
  actions: z.array(mcpActionSchema).max(100),
  nextCursor: mcpHttpId.nullable(),
});
export const mcpDecisionSchema = z.strictObject({
  requestId: mcpHttpId,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approve', 'reject']),
});
export const mcpReconciliationSchema = z.strictObject({
  requestId: mcpHttpId,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(['completed', 'not-performed', 'still-unknown']),
  notes: z.string().trim().min(1).max(4000),
});
export const mcpCancelSchema = z.strictObject({ requestId: mcpHttpId });
