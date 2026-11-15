import { z } from 'zod';
import {
  createSecretInputSchema,
  declineRequestSchema,
  destinationInputSchema,
  grantSchema,
  MAX_DESTINATIONS,
  originSchema,
  placementSchema,
  requestFieldSchema,
  secretKindSchema,
  secretNameSchema,
  secretNamesInputSchema,
  submitRequestSchema,
} from '@tulipfarm/secrets';

const id = z.uuid().transform(value => value.toLowerCase());
const version = z.number().int().positive();
const expiresAt = z.iso.datetime({ offset: true }).nullable();
const destination = z.strictObject({ kind: z.enum(['host', 'endpoint']), value: z.string() });

export const secretsWorkspaceParams = z.strictObject({ workspaceId: id });
export const secretParams = secretsWorkspaceParams.extend({ secretId: id });
export const secretRequestParams = secretsWorkspaceParams.extend({ requestId: id });
export const taskSecretRequestParams = secretsWorkspaceParams.extend({ taskId: id });

export const secretsCapabilitiesSchema = z.strictObject({ enabled: z.boolean() });

export const secretSummarySchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  variableName: z.string(),
  kind: secretKindSchema,
  placement: placementSchema,
  placementSource: z.enum(['agent', 'member']),
  lifetime: z.enum(['saved', 'conversation']),
  origin: originSchema.nullable(),
  destinations: z.array(destination),
  grants: z.array(grantSchema),
  ownerMembershipId: z.uuid(),
  status: z.enum(['active', 'suspended', 'expired', 'deleted']),
  version: z.number().int(),
  policyVersion: z.number().int(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  replacedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  canManage: z.boolean(),
});
export const secretListSchema = z.strictObject({ secrets: z.array(secretSummarySchema) });
export const secretHistorySchema = z.strictObject({
  events: z.array(
    z.strictObject({
      operation: z.string(),
      actorMembershipId: z.uuid().nullable(),
      details: z.record(z.string(), z.unknown()),
      createdAt: z.string(),
    }),
  ),
});
export const secretDeletedSchema = z.strictObject({ deleted: z.literal(true) });

/** Settings always add saved secrets; temporary ones come only from a chat form. */
export const createSecretBody = createSecretInputSchema.omit({ lifetime: true, placementSource: true });
export const replaceSecretBody = z.strictObject({ requestId: z.uuid(), expectedVersion: version, value: z.unknown() });
export const secretDestinationsBody = z.strictObject({
  requestId: z.uuid(),
  expectedPolicyVersion: version,
  destinations: z.array(destinationInputSchema).min(1).max(MAX_DESTINATIONS),
});
export const secretGrantsBody = z.strictObject({
  requestId: z.uuid(),
  expectedPolicyVersion: version,
  grants: z.array(grantSchema).max(50),
});
export const secretNamesBody = secretNamesInputSchema;
export const secretExpiryBody = z.strictObject({ requestId: z.uuid(), expectedPolicyVersion: version, expiresAt });
export const saveSecretBody = z.strictObject({
  requestId: z.uuid(),
  expectedPolicyVersion: version,
  name: secretNameSchema.optional(),
  expiresAt: expiresAt.optional(),
});
export const deleteSecretBody = z.strictObject({ requestId: z.uuid(), expectedVersion: version });

export const secretRequestViewSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['waiting', 'provided', 'declined', 'expired', 'cancelled']),
  revision: z.number().int(),
  expiresAt: z.string(),
  purpose: z.string(),
  destinations: z.array(destination.extend({ plainHttp: z.boolean() })),
  fields: z.array(
    requestFieldSchema.omit({ placement: true }).extend({
      placement: placementSchema.nullable(),
      options: z.array(
        z.strictObject({
          secretId: z.uuid(),
          name: z.string(),
          lifetime: z.enum(['saved', 'conversation']),
          placement: placementSchema,
          expiresAt: z.string().nullable(),
        }),
      ),
    }),
  ),
  declineReason: z.string().nullable(),
});
export const submitSecretRequestBody = submitRequestSchema;
export const declineSecretRequestBody = declineRequestSchema;
export const secretRequestResultSchema = z.strictObject({
  status: z.enum(['provided', 'declined']),
  references: z
    .array(
      z.strictObject({
        referenceId: z.uuid(),
        fieldId: z.string(),
        name: z.string(),
        kind: secretKindSchema,
        placement: placementSchema,
        destinations: z.array(destination),
      }),
    )
    .optional(),
});
export const taskSecretRequestsSchema = z.strictObject({
  requests: z.array(
    z.strictObject({
      id: z.uuid(),
      status: z.enum(['waiting', 'provided', 'declined', 'expired', 'cancelled']),
      revision: z.number().int(),
      expiresAt: z.string(),
      purpose: z.string(),
      declineReason: z.string().nullable(),
      references: z.array(
        z.strictObject({ referenceId: z.uuid(), fieldId: z.string(), name: z.string(), kind: secretKindSchema }),
      ),
    }),
  ),
});

const serverIdentity = z.string().regex(/^[0-9a-f]{64}$/);
export const secretRevealsSchema = z.strictObject({
  reveals: z.array(z.strictObject({ serverIdentity, grantedAt: z.string() })),
});
export const secretRevealBody = z.strictObject({ serverIdentity, revealed: z.boolean() });
export const secretRevealSchema = secretRevealBody;
