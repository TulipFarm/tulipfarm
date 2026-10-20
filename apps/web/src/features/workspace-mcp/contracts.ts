import { z } from 'zod';

const id = z.string().min(1).max(512);
const version = z.number().int().nonnegative();
const text = z.string();
const time = z.iso.datetime({ offset: true });
export const capabilitiesSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    canManageShared: z.boolean(),
    integrationsEnabled: z.boolean(),
    dispatchEnabled: z.boolean(),
  }),
]);
export type Capabilities = Extract<z.infer<typeof capabilitiesSchema>, { enabled: true }>;
export const catalogEntrySchema = z.object({
  id,
  name: text,
  description: text,
  version: text,
  endpoint: text,
  compatibility: z.enum(['eligible', 'unknown', 'unsupported']),
  reason: text.nullable(),
  authentication: z.enum(['none', 'headers', 'bearer', 'oauth', 'unknown']),
});
export const catalogSchema = z.object({
  source: z.literal('Official MCP Registry'),
  snapshotVersion: text,
  syncedAt: time.nullable(),
  stale: z.boolean(),
  entries: z.array(catalogEntrySchema),
  nextCursor: text.nullable(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export const integrationSchema = z.object({
  id,
  name: text,
  ownership: z.enum(['personal', 'shared']),
  endpoint: text,
  accountLabel: text.nullable(),
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
  barrier: z.object({ actionId: id }).nullable(),
  statusReason: text.nullable(),
  reauthorizationRequired: z.boolean().optional(),
});
export type Integration = z.infer<typeof integrationSchema>;
const toolSchema = z.object({
  name: text,
  description: text,
  revision: id,
  previousRevision: id.nullable(),
  inputSchema: z.json(),
  outputSchema: z.json().nullable(),
  compatibility: z.enum(['compatible', 'unsupported']),
  reason: text.nullable(),
  review: z.enum(['new', 'reviewed', 'changed']),
  enabled: z.boolean(),
  standingException: z.boolean(),
});
export const grantSchema = z.object({ kind: z.enum(['member', 'team']), id });
export const integrationDetailSchema = z.object({
  integration: integrationSchema,
  tools: z.array(toolSchema),
  grants: z.array(grantSchema),
  managers: z.array(grantSchema).default([]),
  grantOptions: z.array(grantSchema.extend({ label: text })),
  descriptor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('chat-only'), reason: text }),
    z.object({ kind: z.literal('reviewable'), id, label: text, identity: text }),
    z.object({ kind: z.literal('approved'), id, label: text, identity: text }),
  ]),
});
export type IntegrationDetail = z.infer<typeof integrationDetailSchema>;
export const authSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('bearer'), token: z.string().min(1) }),
  z.object({
    kind: z.literal('headers'),
    headers: z
      .array(z.object({ name: z.string().min(1), value: z.string().min(1) }))
      .min(1)
      .max(10),
  }),
  z.object({
    kind: z.literal('oauth'),
    client: z
      .object({
        clientId: id,
        authMethod: z.enum(['none', 'client_secret_basic', 'client_secret_post']),
        clientSecret: text.optional(),
      })
      .optional(),
  }),
]);
export const setupInputSchema = z.object({
  requestId: id,
  name: z.string().trim().min(1).max(120),
  endpoint: z.url(),
  ownership: z.enum(['personal', 'shared']),
  catalogEntryId: id.optional(),
  auth: authSchema,
  expectedVersion: version.optional(),
});
export type SetupInput = z.infer<typeof setupInputSchema>;
export const setupResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('saved'), integration: integrationSchema }),
  z.object({ kind: z.literal('oauth'), integration: integrationSchema, authorizationUrl: z.url() }),
  z.object({
    kind: z.literal('registration-required'),
    integration: integrationSchema,
    registration: z.object({ instructions: text, redirectUri: z.url(), clientMetadataUrl: z.url() }),
  }),
]);
export type SetupResult = z.infer<typeof setupResultSchema>;
export const bindingSchema = z.object({ integrationId: id, slotId: id.nullable() });
export const selectionSchema = z.object({
  id,
  version,
  bindings: z.array(bindingSchema),
  stale: z.boolean(),
  choices: z.array(
    z.object({
      integration: integrationSchema,
      slotId: id.nullable(),
      slotLabel: text.nullable(),
      unavailableReason: text.nullable(),
    }),
  ),
});
export type Selection = z.infer<typeof selectionSchema>;
export type SelectionOrigin = {
  kind: 'chat' | 'task' | 'task-draft';
  id: string;
  agentId?: string | undefined;
  activationId?: string | undefined;
};
export const permissionSlotSchema = z.object({
  slotId: id,
  serverIdentity: id,
  label: text,
  binding: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('personal') }),
    z.object({ kind: z.literal('shared'), integrationId: id }),
  ]),
  tools: z.array(z.object({ name: text, revision: id })),
});
export type PermissionSlot = z.infer<typeof permissionSlotSchema>;
export const agentPermissionsSchema = z.object({
  savedRevision: id,
  activeRevision: id.nullable(),
  canEdit: z.boolean(),
  slots: z.array(permissionSlotSchema),
  choices: z.array(permissionSlotSchema),
});
export type AgentPermissions = z.infer<typeof agentPermissionsSchema>;
const actionBase = {
  id,
  digest: id,
  integrationId: id,
  integrationName: text,
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
    .object({
      outcome: z.enum(['completed', 'not-performed', 'still-unknown']),
      notes: text,
      observedAt: time,
      observer: text,
      administrative: z.boolean(),
    })
    .nullable(),
  receipt: z
    .object({
      dispatchedAt: time.nullable(),
      receivedAt: time.nullable(),
      outcome: z.enum(['succeeded', 'unknown', 'not-dispatched']),
      text: text.nullable(),
      structured: z.json().nullable(),
    })
    .nullable(),
};
export const actionSchema = z.discriminatedUnion('visibility', [
  z.object({
    ...actionBase,
    visibility: z.literal('full'),
    exact: z.object({
      origin: z.object({ kind: z.enum(['chat', 'task']), id }),
      requester: text,
      endpoint: text,
      accountLabel: text.nullable(),
      authorizationEpoch: version,
      toolName: text,
      toolRevision: id,
      arguments: z.json(),
      sourceLabels: z.array(text),
      outboundConsentRequired: z.boolean(),
      standingExceptionApplied: z.boolean(),
    }),
  }),
  z.object({
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
export type Action = z.infer<typeof actionSchema>;
export const actionsSchema = z.object({ actions: z.array(actionSchema), nextCursor: text.nullable() });
