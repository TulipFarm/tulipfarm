import { AccessDenied, type AuthorizationTransaction } from '@tulipfarm/access';
import { investigationActive } from '@tulipfarm/github/investigation';

const investigationTools = new Set([
  'github.investigation.account',
  'github.investigation.repositories',
  'github.investigation.read',
  'skills.list',
  'skills.read',
  'conversation.messages.read',
  'present.choice',
]);
export async function requireInvestigationToolBoundary(
  tx: AuthorizationTransaction,
  origin: { conversationId: string; turnId: string } | { taskId: string; generation: number },
  tool: string,
) {
  if (investigationTools.has(tool)) return;
  if (await investigationActive(tx, 'taskId' in origin ? { taskId: origin.taskId } : origin.conversationId))
    throw new AccessDenied();
}
