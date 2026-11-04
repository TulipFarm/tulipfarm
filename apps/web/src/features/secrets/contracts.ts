import { z } from 'zod';

export const MAX_DESTINATIONS = 10;
export const TEMPORARY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_VALUE_BYTES = 16 * 1024;

export const secretKinds = ['api-key', 'token', 'password', 'username-password', 'header'] as const;
export type SecretKind = (typeof secretKinds)[number];
export const kindLabels: Record<SecretKind, string> = {
  'api-key': 'API key',
  token: 'Token',
  password: 'Password',
  'username-password': 'Username and password',
  header: 'Header value',
};

export const placementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bearer') }),
  z.object({ kind: z.literal('basic') }),
  z.object({ kind: z.literal('header'), name: z.string() }),
  z.object({ kind: z.literal('cookie'), name: z.string() }),
  z.object({ kind: z.literal('query'), name: z.string() }),
  z.object({ kind: z.literal('body'), format: z.enum(['json', 'form']), fields: z.array(z.string()).min(1).max(2) }),
]);
export type Placement = z.infer<typeof placementSchema>;
export type PlacementKind = Placement['kind'];
export const placementKinds = ['bearer', 'basic', 'header', 'cookie', 'query', 'body'] as const;

/** Plain names for each way to send a secret, with a short technical hint. */
export const placementOptions: Record<PlacementKind, { label: string; hint: string }> = {
  bearer: { label: 'As a bearer token', hint: 'Most APIs. Authorization: Bearer …' },
  header: { label: 'In a header', hint: 'Like X-Api-Key' },
  basic: { label: 'As a sign-in', hint: 'Username and password' },
  query: { label: 'In the web address', hint: 'Like ?key=…' },
  cookie: { label: 'In a cookie', hint: 'For sites that sign in with a cookie' },
  body: { label: 'In the request body', hint: 'A JSON or form field' },
};

const destinationSchema = z.object({ kind: z.enum(['host', 'endpoint']), value: z.string() });
export type Destination = z.infer<typeof destinationSchema>;
export type DestinationInput = { kind: 'host'; host: string } | { kind: 'endpoint'; url: string };

const granteeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), membershipId: z.uuid() }),
  z.object({ kind: z.literal('team'), teamId: z.uuid() }),
  z.object({ kind: z.literal('workspace') }),
]);
export const grantSchema = z.object({ grantee: granteeSchema, role: z.enum(['use', 'manage']) });
export type SecretGrant = z.infer<typeof grantSchema>;

const originSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat'), conversationId: z.uuid() }),
  z.object({ kind: z.literal('task'), taskId: z.uuid(), runId: z.uuid() }),
]);

// Mirrors packages/secrets: the web app does not depend on that package.
export const variableNameSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/);

const MAX_VARIABLE_NAME_LENGTH = 64;
const variableSuffixes: Record<SecretKind, string> = {
  'api-key': '_KEY',
  token: '_TOKEN',
  password: '_PASSWORD',
  'username-password': '_LOGIN',
  header: '_HEADER',
};

/** "Stripe" and `api-key` give STRIPE_KEY. The server adds _2, _3 and so on if the name is taken. */
export function suggestVariableName(name: string, kind: SecretKind) {
  let slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (!slug || /^[0-9]/.test(slug)) slug = `SECRET_${slug}`.replace(/_+$/, '');
  const suffix = /(?:^|_)(?:KEY|TOKEN|PASSWORD|LOGIN|SECRET|HEADER)$/.test(slug) ? '' : variableSuffixes[kind];
  return slug.slice(0, MAX_VARIABLE_NAME_LENGTH - suffix.length).replace(/_+$/, '') + suffix;
}

export const capabilitiesSchema = z.object({ enabled: z.boolean() });
export const secretSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  variableName: z.string(),
  kind: z.enum(secretKinds),
  placement: placementSchema,
  placementSource: z.enum(['agent', 'member']),
  lifetime: z.enum(['saved', 'conversation']),
  origin: originSchema.nullable(),
  destinations: z.array(destinationSchema),
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
export type SecretSummary = z.infer<typeof secretSummarySchema>;
export const secretListSchema = z.object({ secrets: z.array(secretSummarySchema) });
export const secretHistorySchema = z.object({
  events: z.array(
    z.object({
      operation: z.string(),
      actorMembershipId: z.uuid().nullable(),
      details: z.record(z.string(), z.unknown()),
      createdAt: z.string(),
    }),
  ),
});
export type SecretEvent = z.infer<typeof secretHistorySchema>['events'][number];

export const secretRequestViewSchema = z.object({
  id: z.uuid(),
  status: z.enum(['waiting', 'provided', 'declined', 'expired', 'cancelled']),
  revision: z.number().int(),
  expiresAt: z.string(),
  purpose: z.string(),
  destinations: z.array(destinationSchema),
  fields: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(secretKinds),
      placement: placementSchema.nullable(),
      options: z.array(
        z.object({
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
export type SecretRequestView = z.infer<typeof secretRequestViewSchema>;
export const taskSecretRequestsSchema = z.object({
  requests: z.array(
    z.object({
      id: z.uuid(),
      status: z.enum(['waiting', 'provided', 'declined', 'expired', 'cancelled']),
      revision: z.number().int(),
      expiresAt: z.string(),
      purpose: z.string(),
      declineReason: z.string().nullable(),
      references: z.array(z.object({ referenceId: z.uuid(), fieldId: z.string(), name: z.string(), kind: z.string() })),
    }),
  ),
});
export type TaskSecretRequest = z.infer<typeof taskSecretRequestsSchema>['requests'][number];
export type SecretRequestField = SecretRequestView['fields'][number];

export type SecretValue = { value: string } | { username: string; password: string };
export type SubmitField =
  | { fieldId: string; secretId: string }
  | {
      fieldId: string;
      value: SecretValue;
      name?: string;
      lifetime: 'conversation' | 'saved';
      expiresAt?: string | null;
      placement?: Placement;
    };

/** How a secret is sent, as the end of a sentence such as "Sent as a bearer token". */
export function placementPhrase(placement: Placement) {
  switch (placement.kind) {
    case 'bearer':
      return 'as a bearer token';
    case 'basic':
      return 'as a basic sign-in';
    case 'header':
      return placement.name ? `in the ${placement.name} header` : 'in a header';
    case 'cookie':
      return placement.name ? `in the ${placement.name} cookie` : 'in a cookie';
    case 'query':
      return placement.name ? `in the ${placement.name} query parameter` : 'in the address';
    case 'body':
      return 'in the request body';
  }
}

/** The hosts a request's destinations point at, such as "api.stripe.com" or "api.stripe.com and 2 more". */
export function destinationHosts(destinations: Destination[]) {
  const hosts = [
    ...new Set(
      destinations.map(destination => {
        if (destination.kind === 'host') return destination.value;
        try {
          return new URL(destination.value).host;
        } catch {
          return destination.value;
        }
      }),
    ),
  ];
  if (hosts.length <= 2) return hosts.join(' and ');
  return `${hosts[0]} and ${hosts.length - 1} more`;
}

export function destinationLabel(destination: Destination) {
  return destination.kind === 'host' ? `${destination.value} (any address on this host)` : destination.value;
}

/** Mirrors the server: a username and password needs basic sign-in or two body fields; other kinds need one. */
export function placementFits(kind: SecretKind, placement: Placement) {
  if (placement.kind === 'body')
    return (
      new Set(placement.fields).size === placement.fields.length &&
      placement.fields.length === (kind === 'username-password' ? 2 : 1)
    );
  return kind !== 'username-password' || placement.kind === 'basic';
}

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

/** The first problem the server would find with a placement, or null. */
export function placementError(kind: SecretKind, placement: Placement): string | null {
  if (placement.kind === 'header') {
    const name = placement.name.toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) return 'Use letters, numbers and hyphens, starting with a letter.';
    if (reservedHeaders.has(name) || /^(?:proxy-|sec-|mcp-|x-forwarded-|x-http-method)/.test(name))
      return 'This header is reserved. Choose another name or another way to send it.';
  }
  if (placement.kind === 'cookie' && !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/.test(placement.name))
    return 'Enter a cookie name without spaces.';
  if (placement.kind === 'query' && !/^[A-Za-z0-9._~-]{1,64}$/.test(placement.name))
    return 'Enter a parameter name without spaces.';
  if (placement.kind === 'body') {
    if (placement.fields.some(field => !/^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,3}$/.test(field)))
      return 'Use letters, numbers, hyphens and underscores. Use dots for nested fields.';
    if (new Set(placement.fields).size !== placement.fields.length) return 'Use two different field names.';
  }
  if (!placementFits(kind, placement)) return 'Send a username and password with basic sign-in or two body fields.';
  return null;
}

export function valueError(value: SecretValue) {
  const parts = 'value' in value ? [value.value] : [value.username, value.password];
  if (parts.some(part => !part)) return 'Enter a value.';
  if (parts.some(part => /[\r\n\0]/.test(part))) return 'Values cannot contain line breaks.';
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_VALUE_BYTES) return 'This value is too long.';
  return null;
}

/** A full https address limits sending to that endpoint; a bare host name allows any address on it. */
export function destinationInput(text: string): DestinationInput {
  const value = text.trim();
  return /^https?:\/\//i.test(value) ? { kind: 'endpoint', url: value } : { kind: 'host', host: value };
}
