import { loadSecretFiles } from './secret-files.ts';

export function publicWebConfiguration(env: NodeJS.ProcessEnv = process.env) {
  loadSecretFiles(env, ['FIRECRAWL_API_KEY']);
  if (!env.FIRECRAWL_ENDPOINT) return undefined;
  const endpoint = new URL(env.FIRECRAWL_ENDPOINT);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw new Error('FIRECRAWL_ENDPOINT must be an HTTP(S) origin without credentials or a path');
  return {
    endpoint,
    headers: env.FIRECRAWL_API_KEY ? { authorization: `Bearer ${env.FIRECRAWL_API_KEY}` } : {},
    healthPath: env.FIRECRAWL_API_KEY ? '/v2/team/credit-usage' : '/health',
  };
}
