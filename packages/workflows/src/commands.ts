import { createHash } from 'node:crypto';
import { canonical } from '@tulipfarm/workflow-snippets/canonical';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type { AuthorizationTransaction } from '@tulipfarm/access';

export class WorkflowConflict extends Error {}

// Quotas apply per member and per workspace, and unattended runs also per workflow. Runs parked in a
// delay or wait-until step skip those and count only toward their workflow's parked cap. All report the
// same public code so a member cannot infer how much other people have created or started.
export const workflowLimits = { workspace: 100, member: 25, workflow: 10, parked: 100 } as const;
export class WorkflowLimitReached extends WorkflowConflict {
  readonly scope: 'member' | 'workspace' | 'workflow' | 'parked';
  constructor(scope: 'member' | 'workspace' | 'workflow' | 'parked') {
    super('limit-reached');
    this.scope = scope;
  }
}

type AdministrativeInput = {
  commandId: string;
  expectedGeneration: number;
  generation: number;
  membershipId: string;
  operation: string;
  target: string;
  request: unknown;
};
export async function administrativeReplay(tx: AuthorizationTransaction, input: AdministrativeInput) {
  const table = qualified(tx.schema, 'tf_workflow_commands');
  const hash = createHash('sha256')
    .update(canonical([input.membershipId, input.operation, input.target, input.expectedGeneration, input.request]))
    .digest('hex');
  const previous = (await tx.client.query(`SELECT request_hash FROM ${table} WHERE id=$1`, [input.commandId])).rows[0];
  if (previous) {
    if (previous.request_hash !== hash) throw new WorkflowConflict('command-conflict');
    return true;
  }
  if (input.expectedGeneration !== input.generation) throw new WorkflowConflict('stale-generation');
  return false;
}

export async function administrativeCommand(
  tx: AuthorizationTransaction,
  input: AdministrativeInput,
  apply: () => Promise<void>,
) {
  if (await administrativeReplay(tx, input)) return;
  const table = qualified(tx.schema, 'tf_workflow_commands');
  const hash = createHash('sha256')
    .update(canonical([input.membershipId, input.operation, input.target, input.expectedGeneration, input.request]))
    .digest('hex');
  await apply();
  await tx.client.query(`INSERT INTO ${table} (id,request_hash) VALUES ($1,$2)`, [input.commandId, hash]);
}
