import { KeyObject, sign } from 'node:crypto';
import { observeFetch } from '@tulipfarm/observability';
import { z } from 'zod';
import { githubEventIdSchema } from './event-contracts.ts';

export class GitHubAppError extends Error {
  readonly code: 'access-denied' | 'rate-limited' | 'unavailable' | 'invalid-response' | 'identity-mismatch';
  constructor(code: GitHubAppError['code']) {
    super(code);
    this.code = code;
  }
}
const providerId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String).pipe(githubEventIdSchema);
const installationSchema = z.object({
  id: providerId,
  app_id: providerId,
  account: z.object({ id: providerId, login: z.string().min(1).max(255), type: z.enum(['User', 'Organization']) }),
  repository_selection: z.enum(['all', 'selected']),
  suspended_at: z.iso.datetime().nullable(),
  permissions: z.record(z.string().max(100), z.enum(['read', 'write', 'admin'])),
  events: z.array(z.string().max(100)).max(100),
});
const readPermissions = { pull_requests: 'read', issues: 'read', metadata: 'read' } as const;
const tokenSchema = z.object({
  token: z
    .string()
    .min(1)
    .max(16384)
    .regex(/^[\x21-\x7e]+$/),
  expires_at: z.iso.datetime(),
  permissions: z.strictObject({
    pull_requests: z.literal('read'),
    issues: z.literal('read'),
    metadata: z.literal('read'),
  }),
  repositories: z.array(z.object({ id: providerId })).length(1),
});
const bodyLimit = 131072;

export function createGitHubAppProvider(options: {
  appId: string;
  clientId: string;
  privateKey: KeyObject;
  fetcher?: typeof fetch;
}) {
  const appId = githubEventIdSchema.parse(options.appId);
  const clientId = z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .parse(options.clientId);
  const privateKey = options.privateKey,
    fetcher = options.fetcher ?? fetch;
  if (
    !(privateKey instanceof KeyObject) ||
    privateKey.type !== 'private' ||
    privateKey.asymmetricKeyType !== 'rsa' ||
    (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new Error('Invalid GitHub App private key');
  }
  function jwt() {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: clientId, iat: now - 60, exp: now + 540 })).toString('base64url');
    const input = `${header}.${payload}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
  }
  async function request(path: string, method: 'GET' | 'POST', body?: object): Promise<unknown> {
    try {
      const response = await observeFetch(
        'github',
        'request',
        fetcher,
      )(`https://api.github.com${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${jwt()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'TulipFarm',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
      ) {
        await response.body?.cancel();
        throw new GitHubAppError('rate-limited');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new GitHubAppError([401, 403, 404].includes(response.status) ? 'access-denied' : 'unavailable');
      }
      if (!response.body || !response.headers.get('content-type')?.includes('json')) {
        await response.body?.cancel();
        throw new GitHubAppError('invalid-response');
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > bodyLimit) throw new GitHubAppError('invalid-response');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError) throw new GitHubAppError('invalid-response');
        throw error;
      }
    } catch (error) {
      if (error instanceof GitHubAppError) throw error;
      if (
        error instanceof TypeError ||
        (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))
      ) {
        throw new GitHubAppError('unavailable');
      }
      throw error;
    }
  }
  async function installation(id: string) {
    const installationId = githubEventIdSchema.parse(id);
    const result = installationSchema.safeParse(await request(`/app/installations/${installationId}`, 'GET'));
    if (!result.success) throw new GitHubAppError('invalid-response');
    if (result.data.id !== installationId || result.data.app_id !== appId)
      throw new GitHubAppError('identity-mismatch');
    return result.data;
  }
  async function withRepositoryToken<T>(
    id: string,
    repositoryIdInput: string,
    operation: (token: string) => Promise<T>,
  ) {
    const installationId = githubEventIdSchema.parse(id);
    const repositoryId = githubEventIdSchema
      .refine(value => Number.isSafeInteger(Number(value)))
      .parse(repositoryIdInput);
    const result = tokenSchema.safeParse(
      await request(`/app/installations/${installationId}/access_tokens`, 'POST', {
        repository_ids: [Number(repositoryId)],
        permissions: readPermissions,
      }),
    );
    if (!result.success) throw new GitHubAppError('invalid-response');
    const token = result.data,
      expiry = Date.parse(token.expires_at),
      now = Date.now();
    if (token.repositories[0]?.id !== repositoryId) throw new GitHubAppError('identity-mismatch');
    if (expiry <= now || expiry > now + 3660000) throw new GitHubAppError('invalid-response');
    return operation(token.token);
  }
  return { installation, withRepositoryToken };
}
