import { z } from 'zod';
import { normalizeEndpoint } from '@tulipfarm/workspace-mcp-transport';

export type SecretErrorCode =
  | 'disabled'
  | 'invalid-input'
  | 'conflict'
  | 'not-found'
  | 'unavailable'
  | 'expired'
  | 'destination-denied'
  | 'placement-unsupported'
  | 'placement-required'
  | 'credential-unavailable';

export class SecretError extends Error {
  readonly code: SecretErrorCode;
  constructor(code: SecretErrorCode, message: string = code) {
    super(message);
    this.name = 'SecretError';
    this.code = code;
  }
}

export const MAX_VALUE_BYTES = 16 * 1024;
export const MAX_DESTINATIONS = 10;
export const TEMPORARY_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const secretKindSchema = z.enum(['api-key', 'token', 'password', 'username-password', 'header']);
export type SecretKind = z.infer<typeof secretKindSchema>;

// Names that have their own placement, or that a client must never set.
const reservedHeaders = new Set([
  'authorization',
  'proxy-authorization',
  'host',
  'cookie',
  'cookie2',
  'set-cookie',
  'connection',
  'content-length',
  'content-type',
  'accept',
  'accept-encoding',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'origin',
  'referer',
  'user-agent',
  'expect',
  'forwarded',
  'via',
  'range',
  'traceparent',
  'tracestate',
]);
export const headerNameSchema = z
  .string()
  .transform(name => name.toLowerCase())
  .refine(
    name =>
      /^[a-z][a-z0-9-]{0,63}$/.test(name) &&
      !reservedHeaders.has(name) &&
      !/^(?:proxy-|sec-|mcp-|x-forwarded-|x-http-method)/.test(name),
    'Header name is not allowed',
  );
const cookieNameSchema = z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/);
const queryNameSchema = z.string().regex(/^[A-Za-z0-9._~-]{1,64}$/);
// JSON fields may name a nested path with dots, such as `auth.key`.
const bodyFieldSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,3}$/);

export const placementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bearer') }),
  z.strictObject({ kind: z.literal('basic') }),
  z.strictObject({ kind: z.literal('header'), name: headerNameSchema }),
  z.strictObject({ kind: z.literal('cookie'), name: cookieNameSchema }),
  z.strictObject({ kind: z.literal('query'), name: queryNameSchema }),
  z.strictObject({
    kind: z.literal('body'),
    format: z.enum(['json', 'form']),
    fields: z.array(bodyFieldSchema).min(1).max(2),
  }),
]);
export type Placement = z.infer<typeof placementSchema>;
export type PlacementKind = Placement['kind'];
export const placementKinds = ['bearer', 'basic', 'header', 'cookie', 'query', 'body'] as const;

/** A username-and-password secret needs two body fields; every other kind needs one. */
export function placementFits(kind: SecretKind, placement: Placement): boolean {
  if (placement.kind === 'body') {
    const fields = new Set(placement.fields);
    if (fields.size !== placement.fields.length) return false;
    return placement.fields.length === (kind === 'username-password' ? 2 : 1);
  }
  if (kind === 'username-password') return placement.kind === 'basic';
  return true;
}

const text = z
  .string()
  .min(1)
  .refine(value => !/[\r\n\0]/.test(value), 'Value cannot contain line breaks');
export const secretValueSchema = z.union([
  z.strictObject({ value: text }),
  z.strictObject({ username: text, password: text }),
]);
export type SecretValue = z.infer<typeof secretValueSchema>;

export function parseValue(kind: SecretKind, input: unknown): SecretValue {
  const value = secretValueSchema.parse(input);
  if ((kind === 'username-password') !== 'username' in value) throw new SecretError('invalid-input');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_VALUE_BYTES) throw new SecretError('invalid-input');
  return value;
}

/** The parts of a value, for reflection checks. */
export function valueParts(value: SecretValue): string[] {
  return 'value' in value ? [value.value] : [value.username, value.password];
}

export const destinationInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host'), host: z.string().min(1).max(253) }),
  z.strictObject({ kind: z.literal('endpoint'), url: z.string().min(1).max(4096) }),
]);
export type DestinationInput = z.infer<typeof destinationInputSchema>;
export type Destination = { kind: 'host'; value: string } | { kind: 'endpoint'; value: string };

export function normalizeDestination(input: DestinationInput): Destination {
  try {
    if (input.kind === 'endpoint') return { kind: 'endpoint', value: normalizeEndpoint(input.url) };
    const host = input.host.replace(/^https:\/\//i, '').replace(/\/$/, '');
    if (!host || /[/?#@:]/.test(host)) throw new Error();
    const url = new URL(normalizeEndpoint(`https://${host}/`));
    return { kind: 'host', value: url.hostname };
  } catch {
    throw new SecretError('destination-denied');
  }
}

export function normalizeDestinations(inputs: readonly DestinationInput[]): Destination[] {
  if (!inputs.length || inputs.length > MAX_DESTINATIONS) throw new SecretError('invalid-input');
  const unique = new Map<string, Destination>();
  for (const input of inputs) {
    const destination = normalizeDestination(destinationInputSchema.parse(input));
    unique.set(`${destination.kind}:${destination.value}`, destination);
  }
  return [...unique.values()].sort((a, b) => `${a.kind}:${a.value}`.localeCompare(`${b.kind}:${b.value}`));
}

/** True when a secret with these destinations may be sent to `url`. */
export function destinationAllows(destinations: readonly Destination[], url: string): boolean {
  let normalized: string;
  try {
    normalized = normalizeEndpoint(url);
  } catch {
    return false;
  }
  const host = new URL(normalized).hostname;
  return destinations.some(destination =>
    destination.kind === 'host' ? destination.value === host : destination.value === normalized,
  );
}

export const originSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('chat'), conversationId: z.uuid() }),
  z.strictObject({ kind: z.literal('task'), taskId: z.uuid(), runId: z.uuid() }),
]);
export type SecretOrigin = z.infer<typeof originSchema>;
export const sameOrigin = (a: SecretOrigin, b: SecretOrigin) =>
  a.kind === 'chat'
    ? b.kind === 'chat' && a.conversationId === b.conversationId
    : b.kind === 'task' && a.taskId === b.taskId && a.runId === b.runId;

export const lifetimeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('saved') }),
  z.strictObject({ kind: z.literal('conversation'), origin: originSchema }),
]);
export type Lifetime = z.infer<typeof lifetimeSchema>;

export const granteeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('member'), membershipId: z.uuid() }),
  z.strictObject({ kind: z.literal('team'), teamId: z.uuid() }),
  z.strictObject({ kind: z.literal('workspace') }),
]);
export const grantSchema = z.strictObject({ grantee: granteeSchema, role: z.enum(['use', 'manage']) });
export type SecretGrant = z.infer<typeof grantSchema>;

export const secretNameSchema = z.string().trim().min(1).max(80);

export const createSecretInputSchema = z.strictObject({
  requestId: z.uuid(),
  name: secretNameSchema,
  kind: secretKindSchema,
  value: z.unknown(),
  placement: placementSchema,
  placementSource: z.enum(['agent', 'member']).default('member'),
  destinations: z.array(destinationInputSchema).min(1).max(MAX_DESTINATIONS),
  lifetime: lifetimeSchema.default({ kind: 'saved' }),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  grants: z.array(grantSchema).max(50).default([]),
});
export type CreateSecretInput = z.input<typeof createSecretInputSchema>;

export type SecretStatus = 'active' | 'suspended' | 'expired' | 'deleted';
export type SecretSummary = {
  id: string;
  name: string;
  kind: SecretKind;
  placement: Placement;
  placementSource: 'agent' | 'member';
  lifetime: 'saved' | 'conversation';
  origin: SecretOrigin | null;
  destinations: Destination[];
  grants: SecretGrant[];
  ownerMembershipId: string;
  status: SecretStatus;
  version: number;
  policyVersion: number;
  expiresAt: string | null;
  createdAt: string;
  replacedAt: string | null;
  lastUsedAt: string | null;
  canManage: boolean;
};

export type SecretEvent = {
  operation: string;
  actorMembershipId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

export const fieldIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
export const requestFieldSchema = z.strictObject({
  id: fieldIdSchema,
  label: z.string().trim().min(1).max(80),
  kind: secretKindSchema,
  placement: placementSchema.optional(),
});
export type RequestField = z.infer<typeof requestFieldSchema>;

/** What an agent asks for (P1-P3, P41). */
export const secretRequestInputSchema = z
  .strictObject({
    purpose: z.string().trim().min(1).max(500),
    fields: z.array(requestFieldSchema).min(1).max(5),
    destinations: z.array(destinationInputSchema).min(1).max(MAX_DESTINATIONS),
  })
  .refine(input => new Set(input.fields.map(field => field.id)).size === input.fields.length, 'Duplicate field ID')
  .refine(
    input => input.fields.every(field => !field.placement || placementFits(field.kind, field.placement)),
    'Placement does not fit the kind',
  );
export type SecretRequestInput = z.input<typeof secretRequestInputSchema>;

/** `secrets.request`: asks the member in this chat for secrets through a private form (P1-P4). */
export const secretsRequestCallSchema = z
  .strictObject({
    tool: z.literal('secrets.request'),
    purpose: z.string().trim().min(1).max(500).describe('Why the secret is needed, shown to the member.'),
    fields: z
      .array(requestFieldSchema)
      .min(1)
      .max(5)
      .describe(
        'What to ask for. Set placement only when the API documentation or an authentication hint shows how the secret is sent; otherwise the member chooses.',
      ),
    destinations: z
      .array(destinationInputSchema)
      .min(1)
      .max(MAX_DESTINATIONS)
      .describe('The hosts or exact endpoints the secret may be sent to.'),
  })
  .refine(input => new Set(input.fields.map(field => field.id)).size === input.fields.length, 'Duplicate field ID')
  .refine(
    input => input.fields.every(field => !field.placement || placementFits(field.kind, field.placement)),
    'Placement does not fit the kind',
  );
/** `secrets.list`: the secret references this chat holds (P15). */
export const secretsListCallSchema = z.strictObject({ tool: z.literal('secrets.list') });
