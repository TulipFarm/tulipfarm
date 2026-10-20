import { soulRepositorySchema } from '@tulipfarm/workspaces/soul-explorer-contracts';
import { governanceRequest } from '@/lib/governance';

export function soulApi(workspaceId: string) {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/soul`;
  return {
    snapshot: (signal: AbortSignal) =>
      governanceRequest(`${base}/snapshot`, 'GET', undefined, signal).then(value => soulRepositorySchema.parse(value)),
  };
}
