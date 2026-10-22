import { currentMember, lockAuthorization } from '@tulipfarm/access';
import type { z } from 'zod';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { approvalDecisionSchema, GoogleLifecycleError, type googleProposalSchema } from './lifecycle-contracts.ts';
import {
  authorized,
  decision,
  freshProposal,
  loadProposal,
  proposalLock,
  proposalView,
  receipt,
  table,
  type GoogleOperationRuntime,
} from './operation-store.ts';
import { googleWriteTarget } from './operation-contracts.ts';

export function createGoogleApproval(options: {
  runtime: GoogleOperationRuntime;
  resolveConfirmationCredential: (workspaceId: string) => Promise<string>;
}) {
  const access = authorized(options.runtime);
  return async (
    workspaceId: string,
    userId: string,
    proposalId: string,
    input: unknown,
  ): Promise<z.infer<typeof googleProposalSchema>> => {
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
        await freshProposal(tx, actor, row);
        if (value.digest !== row.digest) throw new GoogleLifecycleError('operation-conflict');
        if (value.decision === 'approve' && googleWriteTarget(row.operation).kind === 'unguarded')
          throw new GoogleLifecycleError('operation-unguarded-update');
        const previous = await decision(tx, row.id);
        if (previous && previous !== value.decision) throw new GoogleLifecycleError('operation-conflict');
        if (!previous) {
          if (await receipt(tx, row.id)) throw new GoogleLifecycleError('operation-conflict');
          await tx.client.query(
            `INSERT INTO ${table(tx, 'decisions')} (proposal_id,membership_id,digest,decision) VALUES ($1,$2,$3,$4)`,
            [row.id, actor.membershipId, row.digest, value.decision],
          );
        }
        return proposalView(tx, row);
      },
    });
  };
}
