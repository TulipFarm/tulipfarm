import { AccessDenied, requireTaskInvocation, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { z } from 'zod';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { idSchema, type AgentStep, type Definition } from './contracts.ts';
import { WorkflowConflict } from './commands.ts';

const agentSteps = (definition: Definition) =>
  definition.steps.filter((step): step is AgentStep => step.kind === 'agent');

async function memberActor(tx: AuthorizationTransaction, membershipId: string): Promise<HumanActor | null> {
  const member = (
    await tx.client.query(
      `SELECT user_id FROM ${qualified(tx.schema, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`,
      [idSchema.parse(membershipId)],
    )
  ).rows[0];
  return member ? { kind: 'human', userId: z.string().parse(member.user_id), membershipId } : null;
}

async function permitted(tx: AuthorizationTransaction, membershipId: string, definition: Definition) {
  const actor = await memberActor(tx, membershipId);
  if (!actor) return false;
  try {
    for (const step of agentSteps(definition)) await requireTaskInvocation(tx, actor, step.agentId);
    return true;
  } catch (error) {
    if (error instanceof AccessDenied) return false;
    throw error;
  }
}

/** Agent outputs are retained in workflow history, so every reader must retain agent invocation access. */
export async function requireAgentStepReader(
  tx: AuthorizationTransaction,
  membershipId: string,
  definition: Definition,
) {
  if (agentSteps(definition).length && !(await permitted(tx, membershipId, definition))) throw new AccessDenied();
}

/** The sponsor starts tasks and the history audience sees their output. */
export async function requireAgentStepAuthority(
  tx: AuthorizationTransaction,
  definition: Definition,
  sponsor: string,
  audience: string[],
) {
  if (!(await permitted(tx, sponsor, definition))) throw new WorkflowConflict('agent-step-access-denied');
  for (const membershipId of audience)
    if (!(await permitted(tx, membershipId, definition))) throw new WorkflowConflict('agent-step-access-denied');
}
