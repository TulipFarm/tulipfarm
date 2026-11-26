import type { ModelProvider } from './model-capabilities.ts';

/** The only API base a member's ChatGPT plan credential is sent to. It cannot be overridden. */
export const chatGptEndpoint = 'https://api.openai.com/v1/';
/** Claude and GitHub Copilot plans run through the vendor's agent SDK, which owns its endpoint; these name the vendor. */
export const claudePlanEndpoint = 'https://api.anthropic.com/';
export const copilotPlanEndpoint = 'https://api.githubcopilot.com/';

/** Built-in API origins. They are always allowed, with any path, so they need no MODEL_ENDPOINT_HOSTS entry. */
export const defaultModelEndpoints = Object.freeze({
  anthropic: 'https://api.anthropic.com/',
  openai: 'https://api.openai.com/',
  xai: 'https://api.x.ai/',
  google: 'https://generativelanguage.googleapis.com/',
  chatgpt: chatGptEndpoint,
  claude: claudePlanEndpoint,
  copilot: copilotPlanEndpoint,
  'byok-anthropic': 'https://api.anthropic.com/',
  'byok-openai': 'https://api.openai.com/',
  'byok-xai': 'https://api.x.ai/',
  'byok-google': 'https://generativelanguage.googleapis.com/',
  'byok-openai-compatible': 'https://api.openai.com/v1/',
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
  if (
    provider === 'chatgpt' ||
    provider === 'claude' ||
    provider === 'copilot' ||
    provider === 'byok-anthropic' ||
    provider === 'byok-openai' ||
    provider === 'byok-xai' ||
    provider === 'byok-google'
  )
    return endpoint === defaultModelEndpoints[provider] ? null : `must be ${defaultModelEndpoints[provider]}`;
  if (provider === 'byok-openai-compatible') return byokEndpointProblem(endpoint, env);
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

const privateIpv4 =
  /^(?:10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|0\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const privateIpv6 =
  /^(?:::1?$|fc|fd|fe[89ab]|::ffff:(?:10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|0\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.))/i;

/** Whether a bare IPv4 or IPv6 address is loopback, link-local, private, or carrier-grade NAT. */
export function isPrivateModelIp(address: string): boolean {
  const normalized = bare(address);
  return privateIpv4.test(normalized) || privateIpv6.test(normalized);
}

/**
 * Validates a member-supplied BYOK OpenAI-compatible base URL. Allows public HTTPS origins (and loopback HTTP outside
 * production) while blocking private/link-local IP literals, `.local`/`.internal` hosts, embedded credentials, queries,
 * and fragments. Requires the normalized trailing-slash form of `normalizeModelEndpoint`.
 */
export function byokEndpointProblem(
  endpoint: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const shape = modelEndpointShapeProblem(endpoint);
  if (shape) return shape;
  if (endpoint !== normalizeModelEndpoint(endpoint)) return 'must be normalized with a trailing slash';
  const url = new URL(endpoint);
  const host = bare(url.hostname);
  const allowLocal = env.NODE_ENV !== 'production';
  const isLoopback = loopbackHosts.has(host);
  if (url.protocol === 'http:') {
    if (!isLoopback) return 'must use https (http is allowed only for localhost)';
    if (!allowLocal) return 'must use https in production';
    return null;
  }
  if (isLoopback) return allowLocal ? null : 'must not target a loopback address in production';
  if (isPrivateModelIp(host) || host.endsWith('.local') || host.endsWith('.internal'))
    return 'must not target a private or internal address';
  return null;
}
