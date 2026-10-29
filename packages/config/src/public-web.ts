import { loadSecretFiles } from './secret-files.ts';

/** Settings that Huntsman and SearXNG replaced, and what replaces each. Startup fails while one is set. */
export const removedPublicWebSettings = Object.freeze({
  FIRECRAWL_ENDPOINT: 'set HUNTSMAN_ENDPOINT for page reads and SEARXNG_ENDPOINT for search',
  FIRECRAWL_API_KEY: 'set HUNTSMAN_TOKEN',
  FIRECRAWL_API_KEY_FILE: 'set HUNTSMAN_TOKEN_FILE',
});

function rejectRemovedSettings(env: NodeJS.ProcessEnv) {
  const set = Object.entries(removedPublicWebSettings).filter(([name]) => env[name]?.trim());
  if (set.length)
    throw new Error(
      `Public web settings changed: Firecrawl is replaced by Huntsman and SearXNG. Remove ${set
        .map(([name, replacement]) => `${name} (${replacement})`)
        .join(', ')}.`,
    );
}

function origin(name: string, value: string) {
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
    throw new Error(`${name} must be an HTTP(S) origin without credentials or a path`);
  return endpoint;
}

/**
 * Where agents read pages (Huntsman) and search the web (SearXNG). Each is off while its endpoint is unset; the result
 * is undefined when both are.
 */
export function publicWebConfiguration(env: NodeJS.ProcessEnv = process.env) {
  rejectRemovedSettings(env);
  loadSecretFiles(env, ['HUNTSMAN_TOKEN', 'SEARXNG_TOKEN']);
  const pages = env.HUNTSMAN_ENDPOINT
    ? {
        endpoint: origin('HUNTSMAN_ENDPOINT', env.HUNTSMAN_ENDPOINT),
        headers: env.HUNTSMAN_TOKEN ? { authorization: `Bearer ${env.HUNTSMAN_TOKEN}` } : {},
        healthPath: '/health',
      }
    : undefined;
  const search = env.SEARXNG_ENDPOINT
    ? {
        endpoint: origin('SEARXNG_ENDPOINT', env.SEARXNG_ENDPOINT),
        headers: env.SEARXNG_TOKEN ? { authorization: `Bearer ${env.SEARXNG_TOKEN}` } : {},
        healthPath: '/healthz',
      }
    : undefined;
  return pages || search ? { pages, search } : undefined;
}
