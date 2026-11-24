import { loadSecretFiles } from './secret-files.ts';

/**
 * Where agents drive browsers: a browser host that runs one isolated Chromium context per browser session.
 * Undefined while BROWSER_HOST_ENDPOINT is unset, which turns browser use off.
 */
export function browserHostConfiguration(env: NodeJS.ProcessEnv = process.env) {
  loadSecretFiles(env, ['BROWSER_HOST_TOKEN']);
  if (!env.BROWSER_HOST_ENDPOINT) return undefined;
  const endpoint = URL.parse(env.BROWSER_HOST_ENDPOINT);
  if (
    !endpoint ||
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw new Error('BROWSER_HOST_ENDPOINT must be an HTTP(S) origin without credentials or a path');
  if (!env.BROWSER_HOST_TOKEN) throw new Error('Set BROWSER_HOST_TOKEN with BROWSER_HOST_ENDPOINT');
  return {
    endpoint: endpoint.origin,
    headers: { authorization: `Bearer ${env.BROWSER_HOST_TOKEN}` } as Readonly<Record<string, string>>,
    healthPath: '/health',
  };
}
