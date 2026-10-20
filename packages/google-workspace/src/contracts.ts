import { z } from 'zod';
import { googleAppScopes, googleIdentityScopes, type GoogleCallbackResult } from './public-contracts.ts';
export {
  googleStatusSchema,
  googleAppScopes,
  googleIdentityScopes,
  googleAppSchema,
  type GoogleApp,
  type GoogleStatus,
} from './public-contracts.ts';

export const googleWorkspaceScopes = [...googleIdentityScopes, ...Object.values(googleAppScopes).flat()];
export const callbackSchema = z
  .object({
    state: z.string().min(1).max(256),
    code: z.string().min(1).max(4096).optional(),
    error: z.string().min(1).max(256).optional(),
  })
  .refine(value => Boolean(value.code) !== Boolean(value.error));
export const sessionPrincipalSchema = z.strictObject({
  userId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
});
export type SessionPrincipal = z.infer<typeof sessionPrincipalSchema>;
export class GoogleWorkspaceError extends Error {
  readonly code:
    | 'not-configured'
    | 'invalid-state'
    | 'consent-denied'
    | 'reconnect-required'
    | 'insufficient-scope'
    | 'stale-integration'
    | 'provider-unavailable'
    | 'credential-unavailable';
  /** For `insufficient-scope` raised by a stored-scope check, the scopes the integration lacks. */
  readonly missingScopes: readonly string[];

  constructor(code: GoogleWorkspaceError['code'], missingScopes: readonly string[] = []) {
    super(code);
    this.code = code;
    this.missingScopes = missingScopes;
  }
}

export class GoogleCallbackError extends Error {
  readonly outcome: Exclude<GoogleCallbackResult['outcome'], 'connected'>;
  readonly workspaceId: string;
  constructor(outcome: GoogleCallbackError['outcome'], workspaceId: string) {
    super(outcome);
    this.outcome = outcome;
    this.workspaceId = workspaceId;
  }
}

const configSchema = z.strictObject({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectUri: z.url().refine(value => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/v1/google-workspace/callback' &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    );
  }),
});
export type GoogleWorkspaceConfig = z.infer<typeof configSchema>;
export function googleWorkspaceConfig(env: NodeJS.ProcessEnv = process.env): GoogleWorkspaceConfig | undefined {
  const values = [
    env.GOOGLE_WORKSPACE_CLIENT_ID,
    env.GOOGLE_WORKSPACE_CLIENT_SECRET,
    env.GOOGLE_WORKSPACE_REDIRECT_URI,
  ];
  if (values.every(value => value === undefined)) return undefined;
  const result = configSchema.safeParse({ clientId: values[0], clientSecret: values[1], redirectUri: values[2] });
  if (!result.success) throw new GoogleWorkspaceError('not-configured');
  return result.data;
}
