export type WorkerRole = 'all' | 'core' | 'knowledge';

/**
 * `all` runs every task queue in one process. `core` and `knowledge` split them so that knowledge sync, which
 * parses documents and is CPU heavy, cannot starve chats, scheduled jobs and the health-check workflow.
 */
export function workerRole(env: NodeJS.ProcessEnv = process.env): WorkerRole {
  const value = env.TULIPFARM_WORKER_ROLE?.trim() || 'all';
  if (value === 'all' || value === 'core' || value === 'knowledge') return value;
  throw new Error('TULIPFARM_WORKER_ROLE must be all, core or knowledge');
}

export function workerTelemetryService(role: WorkerRole) {
  return role === 'knowledge' ? 'tulipfarm-knowledge-worker' : undefined;
}
