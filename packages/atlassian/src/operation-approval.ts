import { currentMember, lockAuthorization } from '@tulipfarm/access';
import type { z } from 'zod';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import type { AccountRuntime } from './accounts.ts';
import { approvalDecisionSchema, OperationError, type proposalSchema } from './operation-contracts.ts';
import {
  authorized,
  decision,
  freshProposal,
  loadProposal,
  proposalLock,
  proposalView,
  receipt,
  table,
} from './operation-store.ts';

export function createAtlassianApproval(options: {
  runtime: AccountRuntime;
  resolveConfirmationCredential: (workspaceId: string) => Promise<string>;
}) {
  const access = authorized(options.runtime);
  return async (
    workspaceId: string,
    userId: string,
    proposalId: string,
    input: unknown,
  ): Promise<z.infer<typeof proposalSchema>> => {
    const value = approvalDecisionSchema.parse(input);
    const actor = await access(workspaceId, userId, async (_tx, actor) => actor);
    const connectionString = await options.resolveConfirmationCredential(workspaceId);
    return withMaintenanceTransaction({
      connectionString,
      workspaceId,
      capability: 'confirmation',
      operation: async tx => {
        await lockAuthorization(tx);
        await currentMember(tx, actor);
        await proposalLock(tx, proposalId);
        const row = await loadProposal(tx, actor, proposalId);
        const { source } = await freshProposal(tx, actor, row);
        if (value.digest !== row.digest) throw new OperationError('operation-conflict');
        const previous = await decision(tx, row.id);
        if (previous && previous !== value.decision) throw new OperationError('operation-conflict');
        if (!previous) {
          if (await receipt(tx, row.id)) throw new OperationError('operation-conflict');
          await tx.client.query(
            `INSERT INTO ${table(tx, 'decisions')} (proposal_id,membership_id,digest,decision) VALUES ($1,$2,$3,$4)`,
            [row.id, actor.membershipId, row.digest, value.decision],
          );
        }
        return proposalView(tx, row, source);
      },
    });
  };
}
