import { createAgentExecutor } from '@tulipfarm/agents';
import { executionIdsSchema } from '@tulipfarm/agents/contracts';
import { createInternalConversations, internalFenceSchema } from '@tulipfarm/conversations/internal';
import { createConversationRequests } from '@tulipfarm/conversations/requests';
import { createTableApprovalRequests } from '@tulipfarm/tables/conversation-approvals';
import { googleOperations } from './google-composition.ts';

type Options = Parameters<typeof createAgentExecutor>[0];

export function createInternalAgentComposition(runtime: Options['runtime']) {
  const conversations = createInternalConversations(runtime);
  const requests = createConversationRequests(runtime);
  const approvals = createTableApprovalRequests(runtime);

  async function execute(value: unknown, callId: string) {
    const fence = internalFenceSchema.parse(value);
    const ids = executionIdsSchema.parse({ workspaceId: fence.workspaceId, runId: fence.runId, callId });
    await conversations.renew(fence);
    return createAgentExecutor({
      runtime,
      google: googleOperations,
      internalActivity: async (tx, executed) => {
        if (executed.workspaceId !== fence.workspaceId || executed.runId !== fence.runId || executed.callId !== callId)
          throw new Error('internal-runtime-unavailable');
        const local: Options['runtime'] = {
          transaction: async (workspace, range, action) => {
            if (workspace !== fence.workspaceId || tx.commonVersion < range.minimum || tx.commonVersion > range.maximum)
              throw new Error('internal-runtime-unavailable');
            return action(tx);
          },
        };
        await createInternalConversations(local).append(fence, {
          producerId: ids.callId,
          parts: [{ kind: 'tool', callId: ids.callId }],
        });
      },
    }).execute(ids);
  }

  return {
    ...conversations,
    execute,
    requestInput: requests.create,
    readInput: requests.readForRuntime,
    requestApproval: approvals.create,
    readApproval: approvals.readForRuntime,
  };
}
