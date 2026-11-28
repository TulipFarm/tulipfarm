import { isFeatureEnabled } from '@tulipfarm/observability';
import type { KnowledgeRetention } from '@tulipfarm/knowledge';
import { z } from 'zod';

const workspaceId = z.uuid();

export function createKnowledgeRetentionActivities(
  retention: Pick<KnowledgeRetention, 'purge'>,
  enabled: (workspaceId: string) => Promise<boolean> = id =>
    isFeatureEnabled('knowledge-retention-purge', null, { id }),
) {
  return {
    /** Deletes one batch of expired Knowledge. Returns 0 when nothing is ready or the purge is switched off. */
    async purgeExpiredKnowledge(workspace: string) {
      const id = workspaceId.parse(workspace);
      if (!(await enabled(id))) return 0;
      return retention.purge(id);
    },
  };
}
