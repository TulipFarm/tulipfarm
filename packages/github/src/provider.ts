import { createHash } from 'node:crypto';
import { observeFetch } from '@tulipfarm/observability';
import { z } from 'zod';
import { GitHubAccountError, GitHubCredentialRejected, identitySchema, scopesSchema } from './contracts.ts';

const secret = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[\x21-\x7e]+$/);
export const configurationSchema = z.strictObject({
  clientId: secret,
  clientSecret: secret,
  redirectUri: z.url().refine(value => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/github/callback' &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    );
  }),
  scopes: scopesSchema.refine(value => value.length > 0),
});
export type Configuration = z.infer<typeof configurationSchema>;
// Knowledge reads private repositories and their contents, so connecting always asks for `repo`.
export const githubRequiredScopes = ['repo'];
const withRequired = (scopes: string[]) =>
  scopes.length ? [...scopes, ...githubRequiredScopes.filter(s => !scopes.includes(s))] : scopes;
export function githubConfiguration(env: NodeJS.ProcessEnv = process.env): Configuration | null {
  const values = [
    env.GITHUB_OAUTH_CLIENT_ID,
    env.GITHUB_OAUTH_CLIENT_SECRET,
    env.GITHUB_OAUTH_REDIRECT_URI,
    env.GITHUB_OAUTH_SCOPES,
  ];
  if (values.every(value => value === undefined)) return null;
  const parsed = configurationSchema.safeParse({
    clientId: values[0],
    clientSecret: values[1],
    redirectUri: values[2],
    scopes: values[3] === undefined ? undefined : withRequired(values[3].split(/\s+/).filter(Boolean)),
  });
  if (!parsed.success) throw new Error('Invalid GitHub OAuth configuration');
  return parsed.data;
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const configurationHash = (config: Configuration) =>
  hash(JSON.stringify([config.clientId, config.clientSecret, config.redirectUri, [...config.scopes].sort()]));
export function authorizationUrl(config: Configuration, state: string, verifier: string) {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(' '),
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.href;
}
async function request(url: string, init: RequestInit, fetcher: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await observeFetch(
      'github',
      'oauth',
      fetcher,
    )(url, { ...init, redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 65536) throw new Error();
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GitHubAccountError('account-unavailable');
  } finally {
    clearTimeout(timer);
  }
}
export function hasScopes(granted: string[], required: string[]) {
  const parents: Record<string, string[]> = {
    'read:user': ['user'],
    'user:email': ['user'],
    'user:follow': ['user'],
    public_repo: ['repo'],
    'repo:status': ['repo'],
    repo_deployment: ['repo'],
    'repo:invite': ['repo'],
    'read:org': ['write:org', 'admin:org'],
    'read:discussion': ['write:discussion'],
    'read:project': ['project'],
  };
  return required.every(
    scope => granted.includes(scope) || (parents[scope] ?? []).some(parent => granted.includes(parent)),
  );
}
export async function exchange(config: Configuration, code: string, verifier: string, fetcher: typeof fetch) {
  const token = z
    .object({
      access_token: secret,
      token_type: z.string().refine(value => value.toLowerCase() === 'bearer'),
      scope: z.string().max(4096),
      expires_in: z.number().int().positive().max(31536000).optional(),
      refresh_token: secret.optional(),
      refresh_token_expires_in: z.number().int().positive().max(31536000).optional(),
    })
    .parse(
      await request(
        'https://github.com/login/oauth/access_token',
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: config.redirectUri,
            code,
            code_verifier: verifier,
          }).toString(),
        },
        fetcher,
      ),
    );
  const scopes = scopesSchema.parse(token.scope.split(/[,\s]+/).filter(Boolean));
  if (!hasScopes(scopes, config.scopes)) throw new GitHubAccountError('account-reconnect-required');
  return {
    accessToken: token.access_token,
    scopes,
    expiresIn: token.expires_in ?? null,
    refreshToken: token.refresh_token ?? null,
    refreshExpiresIn: token.refresh_token_expires_in ?? null,
  };
}
// GitHub answers a bad or reused refresh token with HTTP 200 and an `error` field, and refresh tokens are single-use.
export async function refresh(config: Configuration, refreshToken: string, fetcher: typeof fetch) {
  const body = await request(
    'https://github.com/login/oauth/access_token',
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    },
    fetcher,
  );
  if (typeof body === 'object' && body !== null && 'error' in body) {
    throw new GitHubCredentialRejected();
  }
  const token = z
    .object({
      access_token: secret,
      token_type: z.string().refine(value => value.toLowerCase() === 'bearer'),
      expires_in: z.number().int().positive().max(31536000),
      refresh_token: secret,
      refresh_token_expires_in: z.number().int().positive().max(31536000),
    })
    .parse(body);
  return {
    accessToken: token.access_token,
    expiresIn: token.expires_in,
    refreshToken: token.refresh_token,
    refreshExpiresIn: token.refresh_token_expires_in,
  };
}
export async function identity(accessToken: string, fetcher: typeof fetch) {
  const profile = z
    .object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), login: identitySchema.shape.login })
    .parse(
      await request(
        'https://api.github.com/user',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'TulipFarm',
          },
        },
        fetcher,
      ),
    );
  return identitySchema.parse({ id: String(profile.id), login: profile.login });
}
