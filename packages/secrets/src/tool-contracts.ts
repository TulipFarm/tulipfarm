import { z } from 'zod';

export const MAX_DESTINATIONS = 10;

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

export const destinationInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host'), host: z.string().min(1).max(253) }),
  z.strictObject({ kind: z.literal('endpoint'), url: z.string().min(1).max(4096) }),
]);
export type DestinationInput = z.infer<typeof destinationInputSchema>;

export const fieldIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
export const requestFieldSchema = z.strictObject({
  id: fieldIdSchema,
  label: z.string().trim().min(1).max(80),
  kind: secretKindSchema,
  placement: placementSchema.optional(),
});
export type RequestField = z.infer<typeof requestFieldSchema>;

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
