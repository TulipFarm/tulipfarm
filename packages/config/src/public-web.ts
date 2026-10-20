import { loadSecretFiles } from './secret-files.ts';

export function publicWebConfiguration(env: NodeJS.ProcessEnv = process.env) {
  loadSecretFiles(env, ['PUBLIC_WEB_API_KEY']);
  if (!env.PUBLIC_WEB_ENDPOINT) return undefined;
  const endpoint = new URL(env.PUBLIC_WEB_ENDPOINT);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw new Error('PUBLIC_WEB_ENDPOINT must be an HTTP(S) origin without credentials or a path');
  return {
    endpoint,
    headers: env.PUBLIC_WEB_API_KEY ? { authorization: `Bearer ${env.PUBLIC_WEB_API_KEY}` } : {},
    healthPath: env.PUBLIC_WEB_API_KEY ? '/v2/team/credit-usage' : '/health',
  };
}
