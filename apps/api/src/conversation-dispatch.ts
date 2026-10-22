import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import { createConversationDispatch } from '@tulipfarm/conversations/dispatch';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import type { createTemporalClient } from './temporal.ts';
import type { createAttachments } from '@tulipfarm/conversations/attachments';
import { createConversationRequests } from '@tulipfarm/conversations/requests';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { registerChatLatency } from './chat-latency.ts';
import { createConversationMaintenance } from '@tulipfarm/conversations/maintenance';

export function registerConversationDispatch(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    runtime: ConversationRuntime;
    temporal: ReturnType<typeof createTemporalClient>;
    attachments?: ReturnType<typeof createAttachments> | undefined;
    expireApprovals?: (workspaceId: string) => Promise<void>;
  },
) {
  const { pool, runtime, temporal } = dependencies;
  registerChatLatency(app, pool, runtime);
  const requests = createConversationRequests(runtime);
  const maintenance = createConversationMaintenance(runtime);
  const dispatch = createConversationDispatch({
    runtime,
    start: async work => {
      await temporal.connection.withDeadline(Date.now() + 10000, () =>
        temporal.client.workflow.start('conversationReply', {
          workflowId: `conversation-reply-v1-${work.workspaceId}-${work.turnId}-${work.generation}`,
          taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
          args: [work],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        }),
      );
    },
  });
  let after: string | null = null;
  async function sweep(stopped: () => boolean) {
    const rows = await readyWorkspaces(pool, after, 100);
    for (const row of rows) {
      if (stopped()) return;
      try {
        await requests.expire(row.workspace_id);
      } catch (error) {
        if (!(error instanceof StorageUnavailableError && error.code === 'incompatible_version'))
          app.log.error({ workspaceId: row.workspace_id }, 'Request expiry will retry');
      }
      try {
        await dependencies.expireApprovals?.(row.workspace_id);
      } catch (error) {
        if (!(error instanceof StorageUnavailableError && error.code === 'incompatible_version'))
          app.log.error({ workspaceId: row.workspace_id }, 'Approval expiry will retry');
      }
      try {
        await dispatch(row.workspace_id);
      } catch {
        app.log.error({ workspaceId: row.workspace_id }, 'Conversation dispatch will retry');
      }
      try {
        if (stopped()) return;
        const outcome = await maintenance.sweep(row.workspace_id);
        if (outcome.closed || outcome.queued)
          app.log.info({ workspaceId: row.workspace_id, ...outcome }, 'Conversation maintenance sweep');
        await maintenance.dispatch(
          row.workspace_id,
          work =>
            temporal.connection.withDeadline(Date.now() + 10000, async () => {
              await temporal.client.workflow.start('conversationMaintenance', {
                workflowId: `conversation-maintenance-v1-${work.workspaceId}-${work.jobId}-${work.dispatchEpoch}`,
                taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
                args: [work],
                workflowIdConflictPolicy: 'USE_EXISTING',
                workflowIdReusePolicy: 'ALLOW_DUPLICATE',
              });
            }),
          stopped,
        );
      } catch (error) {
        if (!(error instanceof StorageUnavailableError && error.code === 'incompatible_version'))
          app.log.error({ workspaceId: row.workspace_id }, 'Conversation maintenance will retry');
      }
      try {
        await dependencies.attachments?.cleanup(row.workspace_id);
      } catch {
        app.log.error({ workspaceId: row.workspace_id }, 'Attachment cleanup will retry');
      }
      after = row.workspace_id;
    }
    if (rows.length < 100) after = null;
  }
  backgroundSweep(app, sweep, 'Conversation discovery will retry', 'conversation-discovery');
}
