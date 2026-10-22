import { AccessDenied, lockAuthorization } from '@tulipfarm/access';
import { readWorkspaceInventory } from '@tulipfarm/agents/tools';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { requireCurrentConversationSources } from '@tulipfarm/conversations/source-access';
import { turnRequester } from '@tulipfarm/conversations/turn-requester';
import {
  renewConversationReplyLease,
  type ConversationRuntime,
  type ReplyFence,
} from '@tulipfarm/conversations/runtime';

export function readConversationInventory(runtime: ConversationRuntime, fence: ReplyFence) {
  return runtime.transaction(fence.workspaceId, commonCompatibility, async tx => {
    await lockAuthorization(tx, 'write');
    const slack = await requireCurrentConversationSources(tx, fence.conversationId, fence.turnId);
    await renewConversationReplyLease(tx, fence);
    const chat = (
      await tx.client.query(
        `SELECT project_id,EXISTS(SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_default_turns')} WHERE conversation_id=$1) AS external FROM ${qualified(tx.schema, 'tf_conversations')} WHERE id=$1`,
        [fence.conversationId],
      )
    ).rows[0];
    if (!chat) throw new AccessDenied();
    if (slack || chat.external || chat.project_id) return undefined;
    const actor = await turnRequester(tx, fence.conversationId, fence.turnId);
    const local: ConversationRuntime = {
      transaction: async (workspaceId, range, operation) => {
        if (workspaceId !== fence.workspaceId || tx.commonVersion < range.minimum || tx.commonVersion > range.maximum)
          throw new AccessDenied();
        return operation(tx);
      },
    };
    return readWorkspaceInventory(local, fence.workspaceId, actor);
  });
}
