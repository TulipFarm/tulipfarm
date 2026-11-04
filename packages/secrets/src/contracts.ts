import { z } from 'zod';
import {
  normalizeDestination as normalizeTransportDestination,
  normalizeEndpoint,
  type DestinationAddresses,
  type PrivateHost,
} from '@tulipfarm/workspace-mcp-transport';
import {
  MAX_DESTINATIONS,
  secretKindSchema,
  type SecretKind,
  placementSchema,
  type Placement,
  placementFits,
  destinationInputSchema,
  type DestinationInput,
  requestFieldSchema,
} from './tool-contracts.ts';
export {
  MAX_DESTINATIONS,
  secretKindSchema,
  type SecretKind,
  headerNameSchema,
  placementSchema,
  type Placement,
  type PlacementKind,
  placementKinds,
  placementFits,
  destinationInputSchema,
  type DestinationInput,
  fieldIdSchema,
  requestFieldSchema,
  type RequestField,
  secretsRequestCallSchema,
  secretsListCallSchema,
} from './tool-contracts.ts';

export type SecretErrorCode =
  | 'disabled'
  | 'invalid-input'
  | 'conflict'
  | 'variable-name-taken'
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
export const TEMPORARY_LIFETIME_MS = 24 * 60 * 60 * 1000;

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

export type Destination = { kind: 'host'; value: string } | { kind: 'endpoint'; value: string };

const addressesOf = (privateHosts: readonly PrivateHost[]): DestinationAddresses =>
  privateHosts.length ? { privateHosts } : 'public';

/** A destination may name a host on the operator's private host list while it is listed (API calls P13). */
export function normalizeDestination(input: DestinationInput, privateHosts: readonly PrivateHost[] = []): Destination {
  try {
    if (input.kind === 'endpoint')
      return { kind: 'endpoint', value: normalizeEndpoint(input.url, addressesOf(privateHosts)) };
    const host = input.host.replace(/^https:\/\//i, '').replace(/\/$/, '');
    if (!host || /[/?#@:]/.test(host)) throw new Error();
    if (privateHosts.some(entry => entry.host === host)) return { kind: 'host', value: host };
    const url = new URL(normalizeEndpoint(`https://${host}/`));
    return { kind: 'host', value: url.hostname };
  } catch {
    throw new SecretError('destination-denied');
  }
}

export function normalizeDestinations(
  inputs: readonly DestinationInput[],
  privateHosts: readonly PrivateHost[] = [],
): Destination[] {
  if (!inputs.length || inputs.length > MAX_DESTINATIONS) throw new SecretError('invalid-input');
  const unique = new Map<string, Destination>();
  for (const input of inputs) {
    const destination = normalizeDestination(destinationInputSchema.parse(input), privateHosts);
    unique.set(`${destination.kind}:${destination.value}`, destination);
  }
  return [...unique.values()].sort((a, b) => `${a.kind}:${a.value}`.localeCompare(`${b.kind}:${b.value}`));
}

/**
 * True when a secret with these destinations may be sent to `url`. A private host must be on the current list, so
 * one the operator removed is denied while its secrets stay saved.
 */
export function destinationAllows(
  destinations: readonly Destination[],
  url: string,
  privateHosts: readonly PrivateHost[] = [],
): boolean {
  const addresses = addressesOf(privateHosts);
  let host: string;
  try {
    host = normalizeTransportDestination(url, addresses).hostname;
  } catch {
    return false;
  }
  let endpoint: string | null;
  try {
    endpoint = normalizeEndpoint(url, addresses);
  } catch {
    // A request may carry query keys, such as `code`, that an endpoint destination cannot name.
    endpoint = null;
  }
  return destinations.some(destination =>
    destination.kind === 'host' ? destination.value === host : destination.value === endpoint,
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

export const MAX_VARIABLE_NAME_LENGTH = 64;
/** The environment-variable style name a secret is handed to code under, such as `STRIPE_KEY`. */
export const variableNameSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'Use letters, digits and underscores, starting with a letter');

const variableNameSuffixes: Record<SecretKind, string> = {
  'api-key': '_KEY',
  token: '_TOKEN',
  password: '_PASSWORD',
  'username-password': '_LOGIN',
  header: '_HEADER',
};

/** Suggests a variable name from a secret's name and kind: "Stripe" and `api-key` give `STRIPE_KEY`. */
export function suggestVariableName(name: string, kind: SecretKind): string {
  let slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (!slug || /^[0-9]/.test(slug)) slug = `SECRET_${slug}`.replace(/_+$/, '');
  const suffix = /(?:^|_)(?:KEY|TOKEN|PASSWORD|LOGIN|SECRET|HEADER)$/.test(slug) ? '' : variableNameSuffixes[kind];
  return slug.slice(0, MAX_VARIABLE_NAME_LENGTH - suffix.length).replace(/_+$/, '') + suffix;
}

/** `base` for 1, else `base_2`, `base_3` and so on, shortened to fit. */
export function numberedVariableName(base: string, number: number): string {
  const suffix = number > 1 ? `_${number}` : '';
  return base.slice(0, MAX_VARIABLE_NAME_LENGTH - suffix.length).replace(/_+$/, '') + suffix;
}

export const createSecretInputSchema = z.strictObject({
  requestId: z.uuid(),
  name: secretNameSchema,
  variableName: variableNameSchema.optional(),
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

/** Renames a secret, its friendly name, its variable name or both. */
export const secretNamesInputSchema = z
  .strictObject({ name: secretNameSchema.optional(), variableName: variableNameSchema.optional() })
  .refine(input => input.name !== undefined || input.variableName !== undefined, 'Give a name or a variable name');
export type SecretNamesInput = z.input<typeof secretNamesInputSchema>;

export type SecretStatus = 'active' | 'suspended' | 'expired' | 'deleted';
export type SecretSummary = {
  id: string;
  name: string;
  variableName: string;
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
