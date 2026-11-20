import { loadSecretFiles } from './secret-files.ts';

export type KeepConfiguration =
  | { readonly status: 'not_configured' }
  | { readonly status: 'configured'; readonly endpoint: URL; readonly token: string | undefined };

/** Where the optional Keep memory service runs. Unset KEEP_ENDPOINT is `not_configured`; an invalid one fails. */
export function keepConfiguration(env: NodeJS.ProcessEnv = process.env): KeepConfiguration {
  loadSecretFiles(env, ['KEEP_TOKEN']);
  const value = env.KEEP_ENDPOINT?.trim();
  if (!value) return { status: 'not_configured' };
  const endpoint = URL.parse(value);
  if (
    !endpoint ||
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw new Error('KEEP_ENDPOINT must be an HTTP(S) origin without credentials or a path');
  return { status: 'configured', endpoint, token: env.KEEP_TOKEN?.trim() || undefined };
}
