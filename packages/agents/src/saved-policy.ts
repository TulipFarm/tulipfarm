import { z } from 'zod';
import {
  currentMember,
  lockAuthorization,
  resolveHuman,
  requireAgentGrant,
  requireTeamMember,
  type HumanActor,
} from '@tulipfarm/access';
import { type AgentStorage, type AgentTransaction } from './store.ts';
import { agentPermissionSchema } from './saved-contracts.ts';
import { requirePersonalDefinitionSources } from './personal-definition-sources.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export const savedAgentCompatibility = commonCompatibility;
export function withHuman<T>(
  runtime: AgentStorage,
  workspaceId: string,
  user: string | HumanActor,
  mode: 'read' | 'write',
  operation: (transaction: AgentTransaction & { commonVersion: number }, actor: HumanActor) => Promise<T>,
) {
  return runtime.transaction(workspaceId, savedAgentCompatibility, async transaction => {
    await lockAuthorization(transaction, mode);
    const actor = typeof user === 'string' ? await resolveHuman(transaction, user) : user;
    await currentMember(transaction, actor);
    return operation(transaction, actor);
  });
}
export async function requireAgentCreation(transaction: AgentTransaction, actor: HumanActor, teamId: string | null) {
  await currentMember(transaction, actor);
  if (teamId) await requireTeamMember(transaction, actor, teamId);
}
export async function requireAgentPermission(
  transaction: AgentTransaction,
  actor: HumanActor,
  agentId: string,
  permission: z.infer<typeof agentPermissionSchema>,
) {
  await requireAgentGrant(transaction, actor, agentId, permission);
  await requirePersonalDefinitionSources(
    transaction,
    [{ kind: 'agent-definition', agentId, revision: 'all-saved-revisions' }],
    actor,
  );
}
