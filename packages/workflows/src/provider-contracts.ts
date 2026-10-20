import { z } from 'zod';

const externalId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const uuid = z.uuid().transform(value => value.toLowerCase());
export const providerSourceSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    provider: z.literal('sheets'),
    spreadsheetId: externalId,
    range: z.string().min(1).max(200),
    keyColumn: z.number().int().min(0).max(99),
  }),
  z.strictObject({
    provider: z.literal('slack'),
    teamId: z.string().regex(/^T[A-Z0-9]+$/),
    channelId: z.string().regex(/^[CD][A-Z0-9]+$/),
    conversation: z.enum(['public', 'direct']),
  }),
  z.strictObject({ provider: z.literal('notion'), dataSourceId: z.uuid() }),
  z.strictObject({ provider: z.literal('gmail'), emailAddress: z.email(), labelId: externalId }),
  z.strictObject({ provider: z.literal('forms'), formId: externalId }),
  z.strictObject({
    provider: z.literal('jira'),
    cloudId: z.uuid(),
    projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,49}$/),
  }),
  z.strictObject({
    provider: z.literal('hubspot'),
    portalId: z.string().regex(/^\d+$/),
    objectType: z.enum(['contacts', 'companies', 'deals', 'tickets']),
  }),
]);
export type ProviderSource = z.infer<typeof providerSourceSchema>;
export const providerTriggerSchema = z.strictObject({
  kind: z.literal('provider'),
  integrationId: uuid,
  event: z.enum(['created', 'updated']),
  minutes: z.number().int().min(1).max(1440),
});
export type ProviderTrigger = z.infer<typeof providerTriggerSchema>;
export const providerIntegrationInputSchema = z.strictObject({
  id: uuid,
  name: z.string().trim().min(1).max(120),
  source: providerSourceSchema,
  token: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/),
  consent: z.literal(true),
});
export const providerTestInputSchema = providerIntegrationInputSchema.pick({ source: true, token: true });
export const providerTestResultSchema = z.strictObject({ verified: z.literal(true) });
export const providerResourceInputSchema = z.strictObject({
  provider: z.enum(['sheets', 'slack', 'notion', 'gmail', 'forms', 'jira', 'hubspot']),
  token: providerIntegrationInputSchema.shape.token,
  resource: z.enum([
    'spreadsheetId',
    'teamId',
    'channelId',
    'dataSourceId',
    'emailAddress',
    'labelId',
    'formId',
    'cloudId',
    'projectKey',
    'portalId',
  ]),
  parentId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9_@.+-]+$/)
    .optional(),
  conversation: z.enum(['public', 'direct']).optional(),
  cursor: z.string().min(1).max(4096).optional(),
});
export const providerResourceResultSchema = z.strictObject({
  items: z.array(z.strictObject({ value: z.string().min(1).max(200), label: z.string().min(1).max(300) })).max(100),
  nextCursor: z.string().min(1).max(4096).nullable(),
});
export type ProviderResourceInput = z.infer<typeof providerResourceInputSchema>;
export const providerUpdateSchema = z.strictObject({
  commandId: uuid,
  expectedGeneration: z.number().int().positive().max(2147483646),
  enabled: z.boolean(),
  token: providerIntegrationInputSchema.shape.token.optional(),
});
export const providerIntegrationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  source: providerSourceSchema,
  enabled: z.boolean(),
  generation: z.number().int(),
  authorized: z.boolean(),
  capabilities: z
    .object({ use: z.boolean(), manage: z.boolean(), rotate: z.boolean() })
    .default({ use: false, manage: false, rotate: false }),
});
export const providerStatusSchema = z.object({
  lastSuccess: z.string().nullable(),
  error: z.string().nullable(),
  pending: z.number().int(),
  nextPoll: z.string().nullable(),
});
export const providerCursorSchema = z
  .strictObject({
    activationFloor: z.iso.datetime().optional(),
    since: z.iso.datetime(),
    until: z.iso.datetime().nullable(),
    page: z.string().max(4096).nullable(),
    snapshot: z.record(z.string(), z.string()).default({}),
    initialized: z.boolean().default(false),
    sequence: z.number().int().nonnegative().default(0),
  })
  .transform(cursor => ({ ...cursor, activationFloor: cursor.activationFloor ?? cursor.since }));
export type ProviderCursor = z.infer<typeof providerCursorSchema>;
const jsonSchema = z.json();
export type ProviderEvent = { key: string; kind: 'created' | 'updated'; payload: z.infer<typeof jsonSchema> };
export type ProviderPage = { cursor: ProviderCursor; events: ProviderEvent[] };
