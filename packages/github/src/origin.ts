import { z } from 'zod';
import {
  AccessDenied,
  mcpSourceClosure,
  requireNoMcpDerived,
  requireGitHubTask,
  requireOrdinaryGitHubChat,
  type SourceDependency,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';

export type GitHubContext = string | { taskId: string };
export const contextId = (context: GitHubContext) =>
  z.uuid().parse(typeof context === 'string' ? context : context.taskId);
export const contextColumn = (context: GitHubContext) => (typeof context === 'string' ? 'conversation_id' : 'task_id');
export const selectionTable = (context: GitHubContext) =>
  typeof context === 'string' ? 'tf_github_chat_selection' : 'tf_github_task_selection';
export async function requireGitHubOrigin(tx: AuthorizationTransaction, actor: HumanActor, context: GitHubContext) {
  if (typeof context === 'string') await requireOrdinaryGitHubChat(tx, actor, contextId(context));
  else await requireGitHubTask(tx, actor, contextId(context));
}
export async function requireGitHubSources(tx: AuthorizationTransaction, sources: readonly SourceDependency[]) {
  if ((await mcpSourceClosure(tx, sources)).length) throw new AccessDenied();
  await requireNoMcpDerived(
    tx,
    sources.filter(source => source.kind !== 'private-task'),
  );
}
