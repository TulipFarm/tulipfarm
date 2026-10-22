import { z } from 'zod';
import {
  protectedSourceClosure,
  requireGitHubTaskExecution,
  sourceDependenciesSchema,
  type HumanActor,
} from '@tulipfarm/access';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { createGitHubInvestigation } from '@tulipfarm/github/investigation';
import { requireInvestigationToolBoundary } from './investigation-boundary.ts';
import { createGitHubBatches, type BatchOptions } from '@tulipfarm/github/batches';
import { GitHubReadError } from '@tulipfarm/github/read-contracts';
import { GitHubBatchError } from '@tulipfarm/github/batch-contracts';
import { GitHubAccountError } from '@tulipfarm/github';
import { githubTaskResultSchema, type githubTaskCallSchema } from './github-task-contracts.ts';
import { relation, type AgentStorage } from './store.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export type GitHubTaskFactory = (runtime: AgentStorage) => ReturnType<typeof createGitHubTaskTools>;
export function createGitHubTaskTools(
  options: BatchOptions &
    Pick<Parameters<typeof createGitHubInvestigation>[0], 'keyring' | 'teamKeyring'> & {
      readBindings?: Parameters<typeof createGitHubReads>[0]['bindings'];
    },
) {
  const reads = createGitHubReads({ ...options, bindings: options.readBindings ?? [] });
  const investigation = createGitHubInvestigation({ ...options, bindings: options.readBindings ?? [] });
  const batches = createGitHubBatches(options);
  return {
    async execute(input: {
      workspaceId: string;
      actor: HumanActor;
      taskId: string;
      generation: number;
      callId: string;
      call: z.infer<typeof githubTaskCallSchema>;
    }) {
      const { workspaceId, actor, taskId, generation, callId, call } = input;
      const origin = { taskId, generation };
      const result = (state: z.infer<typeof githubTaskResultSchema>['state'], data: unknown, sources: unknown = []) =>
        githubTaskResultSchema.parse({
          provider: call.tool.startsWith('github.investigation.') ? 'github-investigation' : 'github-personal',
          state,
          data,
          sources,
        });
      try {
        await options.runtime.transaction(workspaceId, { ...commonCompatibility, minimum: 1 }, async tx => {
          await requireGitHubTaskExecution(tx, actor, taskId, generation, call.tool);
          await requireInvestigationToolBoundary(tx, origin, call.tool);
        });
        if (call.tool === 'github.investigation.account') {
          const account = await investigation.account(workspaceId, actor, origin);
          return result(account.selected ? 'completed' : 'selection-required', account);
        }
        if (call.tool === 'github.investigation.read' || call.tool === 'github.investigation.repositories') {
          const response =
            call.tool === 'github.investigation.read'
              ? await investigation.read(workspaceId, actor, origin, call.operation, call.sourceId)
              : await investigation.repositories(workspaceId, actor, origin, {
                  query: call.query,
                  page: call.page,
                  perPage: call.perPage,
                });
          return result('completed', response.result, response.sources);
        }
        if (call.tool === 'github.personal.account')
          return result('selection-required', {
            instruction:
              'Ask the owner to select a GitHub account in this task. Only that human control delegates account access.',
          });
        if (call.tool === 'github.personal.read' || call.tool === 'github.personal.download') {
          const response =
            call.tool === 'github.personal.read'
              ? await reads.read(workspaceId, actor, origin, call.operation)
              : await reads.prepareDownload(workspaceId, actor, origin, callId, call.operation);
          return result('completed', response.result, response.sources);
        }
        const sources = await options.runtime.transaction(
          workspaceId,
          { ...commonCompatibility, minimum: 1 },
          async tx => {
            await requireGitHubTaskExecution(tx, actor, taskId, generation, call.tool);
            return sourceDependenciesSchema
              .parse(await protectedSourceClosure(tx, [{ kind: 'private-task', taskId }]))
              .filter(source => source.kind !== 'private-task');
          },
        );
        let batch = await batches.propose(
          workspaceId,
          actor,
          callId,
          { ...origin, callId, sources },
          { actions: call.actions },
        );
        const retained = [
          ...sources,
          {
            kind: 'github-personal',
            origin: 'task',
            taskId,
            taskGeneration: generation,
            batchId: batch.snapshot.id,
            accountId: batch.snapshot.accountId,
            membershipId: actor.membershipId,
            generation: batch.snapshot.generation,
            selectionVersion: batch.snapshot.selectionVersion,
          },
        ];
        if (batch.expired && batch.decision === null)
          return result('failed', { batchId: batch.snapshot.id, error: 'batch-expired' }, retained);
        if (batch.decision === null) return result('waiting-approval', batch, retained);
        if (batch.decision === 'reject') return result('completed', batch, retained);
        try {
          batch = await batches.execute(workspaceId, actor, { taskId }, batch.snapshot.id);
        } catch (error) {
          if (!(error instanceof GitHubBatchError) || error.code !== 'batch-tool-limit') throw error;
          return result(
            'tool-limit',
            await batches.status(workspaceId, actor.userId, { taskId }, batch.snapshot.id),
            retained,
          );
        }
        return result(
          batch.actions.some(action => action.status === 'unknown') ? 'unresolved' : 'completed',
          batch,
          retained,
        );
      } catch (error) {
        if (
          error instanceof GitHubReadError ||
          error instanceof GitHubBatchError ||
          error instanceof GitHubAccountError
        )
          return result(
            error.code === 'selection-required' ||
              error.code === 'selection-conflict' ||
              error.code === 'account-reconnect-required'
              ? 'selection-required'
              : 'failed',
            {
              error: error.code,
              ...(call.tool.startsWith('github.investigation.')
                ? {
                    instruction:
                      error.code === 'read-rate-limited'
                        ? 'GitHub rate-limited this source. Preserve allowed partial evidence and retry later with the same source; never switch credentials.'
                        : 'Report the blocked read and any uninspected scope. A failed read is not an empty result. Do not use another credential or tool to bypass it.',
                  }
                : {}),
            },
          );
        throw error;
      }
    },
  };
}

export async function taskGitHubWaiting(tx: Parameters<Parameters<AgentStorage['transaction']>[2]>[0], callId: string) {
  return Boolean(
    (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_github_batches')} b LEFT JOIN ${relation(tx, 'tf_github_batch_decisions')} d ON d.batch_id=b.id WHERE b.command_id=$1 AND b.task_id IS NOT NULL AND ((d.decision IS NULL AND b.expires_at>clock_timestamp()) OR EXISTS(SELECT 1 FROM ${relation(tx, 'tf_github_action_receipts')} r WHERE r.batch_id=b.id AND r.status='unknown'))`,
        [callId],
      )
    ).rowCount,
  );
}
