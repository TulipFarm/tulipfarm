import { z } from 'zod';
import { accountProtocolSchema, type AccountProtocol } from './callback-contracts.ts';
export { accountProtocolSchema, accountCallbackResultSchema, type AccountProtocol } from './callback-contracts.ts';
export const accountUuidSchema = z.uuid().transform(value => value.toLowerCase());
export const accountLimits = { workspace: 100, personal: 20, business: 20 } as const;
const accountStateSchema = z.enum(['authorizing', 'active', 'refreshing', 'reconnect-required', 'disconnected']);
export const accountOwnershipSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('personal') }),
  z.strictObject({ kind: z.literal('business') }),
]);
export const beginAccountSchema = z.strictObject({
  protocol: accountProtocolSchema,
  ownership: accountOwnershipSchema,
});
export const accountGrantsSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  memberIds: z.array(z.uuid()).max(100),
  teamIds: z.array(z.uuid()).max(100),
  managers: z.strictObject({ memberIds: z.array(z.uuid()).max(1000), teamIds: z.array(z.uuid()).max(1000) }).optional(),
});
const secret = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[\x21-\x7e]+$/);
const scope = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9:_.-]+$/);
export const accountScopesSchema = z.array(scope).max(256);
export const oauthConfigurationSchema = z.strictObject({
  clientId: secret,
  clientSecret: secret,
  redirectUri: z.url().refine(value => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    );
  }),
  scopes: z.array(scope).min(1).max(64),
});
export type OAuthConfiguration = z.infer<typeof oauthConfigurationSchema>;
export type AccountConfigurations = Partial<Record<AccountProtocol, OAuthConfiguration>>;
export const tokenResponseSchema = z.object({
  access_token: secret,
  refresh_token: secret.optional(),
  expires_in: z.number().int().min(1).max(31536000),
  token_type: z
    .string()
    .refine(value => value.toLowerCase() === 'bearer')
    .optional(),
  scope: z.string().max(8192).optional(),
});
export const storedTokensSchema = z.strictObject({ accessToken: secret, refreshToken: secret.nullable() });
export const identitySchema = z.strictObject({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
  qualification: z.enum(['verified', 'grant-bound-needs-qualification']),
});
export const tableSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(256),
  url: z
    .url()
    .max(2048)
    .refine(value => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        /^[a-z0-9-]+\.atlassian\.net$/.test(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash &&
        url.pathname === '/' &&
        /^https:\/\/[a-z0-9-]+\.atlassian\.net\/?$/i.test(value)
      );
    }),
  scopes: accountScopesSchema,
});
export const accountMetadataSchema = z.strictObject({
  id: z.uuid(),
  protocol: accountProtocolSchema,
  ownership: z.enum(['personal', 'business']),
  state: accountStateSchema,
  configured: z.boolean(),
  identity: identitySchema.nullable(),
  resources: z.array(tableSchema).max(256),
  scopes: accountScopesSchema,
  generation: z.number().int().positive(),
  grantsVersion: z.number().int().positive(),
  capabilities: z.strictObject({ read: z.boolean(), manage: z.boolean(), use: z.boolean() }),
});
export const accountListSchema = z.strictObject({
  accounts: z.array(accountMetadataSchema).max(accountLimits.workspace),
  providers: z.array(z.strictObject({ protocol: accountProtocolSchema, configured: z.boolean() })).max(3),
});
export const accountAuthorizationSchema = z.strictObject({ accountId: z.uuid(), url: z.url() });
export const accountCompletionSchema = z.strictObject({ workspaceId: z.uuid(), account: accountMetadataSchema });
export const accountDisconnectionSchema = z.strictObject({
  account: accountMetadataSchema,
  providerRevocation: z.literal('manual-required'),
});
const callbackState = z.string().regex(/^[a-f0-9-]{36}\.[a-zA-Z0-9_-]{43}$/);
export const accountCallbackSchema = z.union([
  z.strictObject({ code: z.string().min(1).max(4096), state: callbackState }),
  z.strictObject({
    error: z.string().min(1).max(256),
    state: callbackState,
    error_description: z.string().max(4096).optional(),
    error_uri: z.string().max(2048).optional(),
  }),
]);
export const accountRowSchema = z.object({
  id: z.uuid(),
  protocol: accountProtocolSchema,
  ownership: z.enum(['personal', 'business']),
  owner_membership_id: z.uuid().nullable(),
  generation: z.number().int().positive(),
  grants_version: z.number().int().positive(),
  state: accountStateSchema,
  identity: identitySchema.nullable(),
  resources: z.array(tableSchema).max(256),
  scopes: accountScopesSchema,
  credential: z.unknown(),
  config_hash: z.string(),
  expires_at: z.date().nullable(),
  refresh_started_at: z.date().nullable(),
});
export type AccountRow = z.infer<typeof accountRowSchema>;
export class AccountError extends Error {
  readonly code:
    | 'account-disabled'
    | 'account-conflict'
    | 'account-unavailable'
    | 'account-reconnect-required'
    | 'account-refresh-in-progress'
    | 'account-authorization-denied'
    | 'account-limit-reached';
  constructor(code: AccountError['code']) {
    super(code);
    this.code = code;
  }
}
