export type ApiRole = 'all' | 'requests' | 'jobs';

/**
 * `all` serves requests and runs the scheduled background sweeps in one process. `requests` starts no sweeps, so
 * they cannot hold workspace-storage connections that requests are waiting for; `jobs` runs them. Both roles serve
 * every route, so `/v1/health` keeps answering health checks.
 */
export function apiRole(env: NodeJS.ProcessEnv = process.env): ApiRole {
  const value = env.TULIPFARM_API_ROLE?.trim() || 'all';
  if (value === 'all' || value === 'requests' || value === 'jobs') return value;
  throw new Error('TULIPFARM_API_ROLE must be all, requests or jobs');
}
