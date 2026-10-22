import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createChatLatencyMetrics } from '@tulipfarm/observability';
import { emptyChatLatency, mergeChatLatency, readChatLatency } from '@tulipfarm/conversations/latency';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';

export function registerChatLatency(app: FastifyInstance, pool: Pool, runtime: ConversationRuntime) {
  const metrics = createChatLatencyMetrics();
  let after: string | null = null;
  let nextScan = 0;
  let snapshot = emptyChatLatency();
  backgroundSweep(
    app,
    async stopped => {
      if (Date.now() < nextScan) return;
      try {
        const workspaces = await readyWorkspaces(pool, after, 100);
        for (const workspace of workspaces) {
          if (stopped()) return;
          mergeChatLatency(snapshot, await readChatLatency(runtime, workspace.workspace_id));
          after = workspace.workspace_id;
        }
        if (workspaces.length < 100) {
          metrics.publish(snapshot);
          snapshot = emptyChatLatency();
          after = null;
          nextScan = Date.now() + 30000;
        }
      } catch (error) {
        snapshot = emptyChatLatency();
        after = null;
        nextScan = Date.now() + 30000;
        throw error;
      }
    },
    'Chat latency scan failed; freshness alert remains active',
    'chat-latency-scan',
  );
  app.addHook('onClose', async () => {
    metrics.close();
  });
}
