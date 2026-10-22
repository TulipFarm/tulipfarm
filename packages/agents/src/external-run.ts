import {
  AccessDenied,
  requireAgentRunInvocation,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { requireAgentPermission } from './saved-policy.ts';
import { requirePersonalDefinitionSources } from './personal-definition-sources.ts';

export type ExternalRunGuard = ((tx: AuthorizationTransaction, workspaceId: string, runId: string) => Promise<void>) & {
  record?: (
    tx: AuthorizationTransaction,
    workspaceId: string,
    actor: HumanActor,
    agentId: string,
    runId: string,
  ) => Promise<void>;
};

export async function requireChatInvocation(
  tx: AuthorizationTransaction,
  workspaceId: string,
  actor: HumanActor,
  agentId: string,
  runId: string,
  guard?: ExternalRunGuard,
) {
  if (!guard) return requireAgentPermission(tx, actor, agentId, 'invoke');
  const external = (
    await tx.client.query(`SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_agent_turns')} WHERE run_id=$1`, [runId])
  ).rowCount;
  if (!external) return requireAgentPermission(tx, actor, agentId, 'invoke');
  await requireExternalRun(tx, workspaceId, runId, guard);
  await requireAgentRunInvocation(tx, actor, agentId, runId);
  await requirePersonalDefinitionSources(
    tx,
    [{ kind: 'agent-definition', agentId, revision: 'all-saved-revisions' }],
    actor,
  );
}

export async function requireExternalRun(
  tx: AuthorizationTransaction,
  workspaceId: string,
  runId: string,
  guard?: ExternalRunGuard,
) {
  if (
    !(await tx.client.query(`SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_agent_turns')} WHERE run_id=$1`, [runId]))
      .rowCount
  )
    return;
  if (!guard) throw new AccessDenied();
  await guard(tx, workspaceId, runId);
}
