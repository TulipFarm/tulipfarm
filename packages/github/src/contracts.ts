import { z } from 'zod';

export const uuidSchema = z.uuid().transform(value => value.toLowerCase());
export const accountStateSchema = z.enum(['authorizing', 'active', 'reconnect-required', 'disconnected']);
export const identitySchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]{0,15}$/),
  login: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/),
});
export const scopesSchema = z.array(z.string().regex(/^[a-zA-Z0-9:_-]{1,64}$/)).max(64);
export const accountSchema = z.strictObject({
  id: z.uuid(),
  state: accountStateSchema,
  configured: z.boolean(),
  identity: identitySchema.nullable(),
  generation: z.number().int().positive(),
  scopes: scopesSchema,
});
export const accountListSchema = z.strictObject({
  configured: z.boolean(),
  installUrl: z.url().nullable().default(null),
  accounts: z.array(accountSchema).max(20),
});
export const authorizationSchema = z.strictObject({ accountId: z.uuid(), url: z.url() });
export const completionSchema = z.strictObject({ workspaceId: z.uuid(), account: accountSchema });
export const disconnectionSchema = z.strictObject({
  account: accountSchema,
  providerRevocation: z.literal('manual-required'),
});
export const beginSchema = z.strictObject({});
const state = z.string().regex(/^[a-f0-9-]{36}\.[a-zA-Z0-9_-]{43}$/);
const iss = z.literal('https://github.com/login/oauth').optional();
export const callbackSchema = z.union([
  z.strictObject({ code: z.string().min(1).max(4096), state, iss }),
  z.strictObject({
    error: z.string().min(1).max(256),
    state,
    iss,
    error_description: z.string().max(4096).optional(),
    error_uri: z.string().max(2048).optional(),
  }),
]);
export class GitHubAccountError extends Error {
  readonly code:
    | 'account-disabled'
    | 'account-conflict'
    | 'account-unavailable'
    | 'account-reconnect-required'
    | 'account-authorization-denied'
    | 'account-limit-reached';
  constructor(code: GitHubAccountError['code']) {
    super(code);
    this.code = code;
  }
}
export class GitHubCredentialRejected extends Error {
  constructor() {
    super('github-credential-rejected');
  }
}
