import type { ModelProvider } from './model-capabilities.ts';

/** Built-in API origins. They are always allowed, with any path, so they need no MODEL_ENDPOINT_HOSTS entry. */
export const defaultModelEndpoints = Object.freeze({
  anthropic: 'https://api.anthropic.com/',
  openai: 'https://api.openai.com/',
  xai: 'https://api.x.ai/',
  google: 'https://generativelanguage.googleapis.com/',
} as const satisfies Partial<Record<ModelProvider, string>>);

const azureHost =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
const hostPattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^[0-9a-f:.]+$/;

const bare = (hostname: string) => hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();

/** Host names of MODEL_ENDPOINT_HOSTS, lower-cased and without IPv6 brackets. Throws on a malformed entry. */
export function modelEndpointHosts(env: Record<string, string | undefined>): ReadonlySet<string> {
  const entries = (env.MODEL_ENDPOINT_HOSTS ?? '')
    .split(',')
    .map(entry => bare(entry.trim()))
    .filter(Boolean);
  for (const entry of entries)
    if (!hostPattern.test(entry))
      throw new Error(`MODEL_ENDPOINT_HOSTS: ${JSON.stringify(entry)} is not a host name (no scheme, port or path)`);
  return new Set(entries);
}

/** Checks the parts of an endpoint URL that do not depend on the environment. Returns the problem, or null. */
export function modelEndpointShapeProblem(endpoint: string): string | null {
  if (!URL.canParse(endpoint)) return 'is not a URL';
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'must use https';
  if (url.username || url.password) return 'must not contain credentials';
  if (url.search || url.hash || endpoint.includes('?') || endpoint.includes('#'))
    return 'must not have a query or fragment';
  return null;
}

/** `endpoint` with a trailing slash on its path, the form inference routes carry. */
export function normalizeModelEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.origin}${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}`;
}

/**
 * Whether a model credential may be sent to `endpoint`, and the reason when not. Allowed: a provider's built-in origin,
 * an Azure Foundry resource origin for `azure`, or any URL on a MODEL_ENDPOINT_HOSTS host. Every endpoint uses https;
 * http is allowed only for localhost, 127.0.0.1 and ::1 outside production. URLs never carry credentials, a query or
 * a fragment, and are in the normalized form of `normalizeModelEndpoint`.
 */
export function modelEndpointProblem(
  provider: ModelProvider,
  endpoint: string,
  env: Record<string, string | undefined>,
): string | null {
  const shape = modelEndpointShapeProblem(endpoint);
  if (shape) return shape;
  const url = new URL(endpoint);
  if (endpoint !== normalizeModelEndpoint(endpoint)) return 'must be normalized with a trailing slash';
  const host = bare(url.hostname);
  if (url.protocol === 'http:') {
    if (!loopbackHosts.has(host)) return 'must use https (http is allowed only for localhost)';
    if (env.NODE_ENV === 'production') return 'must use https in production';
  }
  const builtIn =
    provider === 'azure'
      ? url.protocol === 'https:' && !url.port && url.pathname === '/' && azureHost.test(host)
      : provider !== 'openai-compatible' && url.origin === new URL(defaultModelEndpoints[provider]).origin;
  if (builtIn) return null;
  let allowed: ReadonlySet<string>;
  try {
    allowed = modelEndpointHosts(env);
  } catch (error) {
    return (error as Error).message;
  }
  return allowed.has(host) ? null : `host ${host} is not in MODEL_ENDPOINT_HOSTS`;
}
