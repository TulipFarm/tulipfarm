import { turnPlanConnection, turnRequester } from '@tulipfarm/conversations/turn-requester';
import type { ConversationRuntime, ReplyFence } from '@tulipfarm/conversations/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
export {
  isUnusablePlan,
  memberPlans,
  planCredentialsFromEnvironment,
  subscriptionsFromEnvironment,
  type PlanCredentials,
} from '@tulipfarm/agents/member-plans';

/** The member a turn's model calls run for; null for Slack and other turns without a member, which use workspace shares. */
export async function turnCaller(runtime: ConversationRuntime, fence: ReplyFence) {
  try {
    const requester = await runtime.transaction(fence.workspaceId, commonCompatibility, tx =>
      turnRequester(tx, fence.conversationId, fence.turnId),
    );
    return requester.membershipId;
  } catch (error) {
    if (error instanceof AccessDenied) return null;
    throw error;
  }
}

/** The plan account the turn's member picked to answer first, if any. */
export function turnPreferredPlan(runtime: ConversationRuntime, fence: ReplyFence) {
  return runtime.transaction(fence.workspaceId, commonCompatibility, tx =>
    turnPlanConnection(tx, fence.conversationId, fence.turnId),
  );
}
