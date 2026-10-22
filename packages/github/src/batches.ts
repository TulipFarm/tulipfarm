import { randomUUID } from 'node:crypto';
import { observeFetch } from '@tulipfarm/observability';
import { z } from 'zod';
import {
  AccessDenied,
  SourceAuthorizationUnavailable,
  requirePersonalGitHubSelection,
  sourceDependenciesSchema,
  type AuthorizationTransaction,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type { AccountRuntime, createGitHubAccounts } from './accounts.ts';
import {
  batchOriginSchema,
  batchSnapshotSchema,
  githubBatchInputSchema,
  GitHubBatchError,
  type BatchSnapshot,
} from './batch-contracts.ts';
import {
  batchAccess,
  batchLock,
  batchRange,
  batchTable,
  batchView,
  freshBatch,
  loadBatch,
  selectionSource,
  selectOnlyAccount,
  snapshotContext,
} from './batch-store.ts';
import {
  contextColumn,
  contextId,
  requireGitHubOrigin,
  requireGitHubSources,
  selectionTable,
  type GitHubContext,
} from './origin.ts';
import { requireGitHubTaskExecution } from '@tulipfarm/access';
import {
  batchDigest,
  canonical,
  dispatchGitHubWrite,
  prepareFileCommit,
  reconcileGitHubWrite,
  requireWriteTarget,
  writeBindingsSchema,
  writeConfiguration,
  type WriteBinding,
  type WriteOutcome,
} from './write-provider.ts';
import { receiptSource, receiptWrite } from './batch-source-receipts.ts';
import { isRepositoryWrite } from './repository-writes.ts';
import { isFileWrite } from './file-writes.ts';
import { isReleaseWrite, releaseUploadBytes } from './release-writes.ts';
import { isActionsWrite } from './actions-writes.ts';
import { isDiscussionWrite } from './discussion-writes.ts';
import { checkDeletedProjectOwner, checkProjectContent, isProjectWrite } from './project-writes.ts';
import { projectReader } from './write-provider.ts';

export type BatchOptions = {
  runtime: AccountRuntime;
  accounts: ReturnType<typeof createGitHubAccounts>;
  bindings?: readonly WriteBinding[];
  fetcher?: typeof fetch;
  requireSources: (
    tx: AuthorizationTransaction,
    actor: HumanActor,
    sources: readonly SourceDependency[],
  ) => Promise<void>;
};
type BodyAction = Extract<BatchSnapshot['actions'][number], { body: string }>;
function rejectsBodyMarker(action: BatchSnapshot['actions'][number]): action is BodyAction {
  return (
    'body' in action && !['issue.update', 'pull.update', 'release.update', 'release.publish'].includes(action.kind)
  );
}
export function createGitHubBatches(options: BatchOptions) {
  const access = batchAccess(options.runtime);
  const bindings = writeBindingsSchema.parse(options.bindings ?? []);
  const fetcher = observeFetch('github', 'request', options.fetcher ?? fetch);
  const executionFetch =
    (tx: AuthorizationTransaction, actor: HumanActor, snapshot: BatchSnapshot): typeof fetch =>
    async (url, init) => {
      if (snapshot.origin.kind === 'task') {
        await freshBatch(tx, actor, await loadBatch(tx, actor, snapshotContext(snapshot), snapshot.id));
      }
      return fetcher(url, init);
    };
  async function check(tx: AuthorizationTransaction, actor: HumanActor, snapshot: BatchSnapshot) {
    await requireGitHubSources(tx, snapshot.sources);
    await requirePersonalGitHubSelection(tx, actor, selectionSource(snapshot));
    const view = await batchView(tx, await loadBatch(tx, actor, snapshotContext(snapshot), snapshot.id));
    for (const source of snapshot.sources) {
      if (source.kind !== 'github-personal') continue;
      await requirePersonalGitHubSelection(tx, actor, source);
      if (source.origin === 'task' && source.batchId) {
        if (!tx.requireGitHubSource) throw new AccessDenied();
        await tx.requireGitHubSource(actor, source);
        continue;
      }
      if (!source.proof || !tx.requireGitHubSourceAccess) throw new AccessDenied();
      const current = receiptSource(source, view);
      if (current) await tx.requireGitHubSourceAccess(actor, current);
    }
    await options.requireSources(
      tx,
      actor,
      snapshot.sources.filter(
        source =>
          source.kind !== 'github-personal' &&
          !(
            source.kind === 'private-conversation' &&
            snapshot.origin.kind === 'chat' &&
            source.conversationId === snapshot.origin.conversationId
          ),
      ),
    );
  }
  async function read(workspaceId: string, principal: string | HumanActor, conversationId: GitHubContext, id: string) {
    const prepared = await access(workspaceId, principal, conversationId, async (tx, actor) => {
      const row = await loadBatch(tx, actor, conversationId, id);
      await check(tx, actor, row.snapshot);
      return { row, actor };
    });
    return options.accounts.withCredential(
      workspaceId,
      prepared.actor,
      prepared.row.snapshot.accountId,
      async (credential, tx) => {
        await check(tx, prepared.actor, prepared.row.snapshot);
        const view = await batchView(tx, await loadBatch(tx, prepared.actor, conversationId, id));
        for (const operation of view.snapshot.actions) {
          const current = receiptWrite(operation, view);
          if (current) await requireWriteTarget(current, credential, fetcher);
          else if (isProjectWrite(operation)) {
            await checkDeletedProjectOwner(operation, credential, projectReader(credential, fetcher));
            await checkProjectContent(operation, credential, projectReader(credential, fetcher));
          }
        }
        return view;
      },
      prepared.row.snapshot.generation,
      (tx, actor) => requireGitHubOrigin(tx, actor, conversationId),
    );
  }
  return {
    read,
    async status(workspaceId: string, userId: string, conversationId: GitHubContext, id: string) {
      return access(workspaceId, userId, conversationId, async (tx, actor) => {
        const row = await loadBatch(tx, actor, conversationId, id);
        await requirePersonalGitHubSelection(tx, actor, selectionSource(row.snapshot));
        const view = await batchView(tx, row);
        return {
          id,
          decision: view.decision,
          actions: view.actions.map(({ ordinal, status }) => ({ ordinal, status })),
        };
      });
    },
    async list(workspaceId: string, userId: string, conversationId: GitHubContext) {
      const column = contextColumn(conversationId);
      const ids = await access(workspaceId, userId, conversationId, async (tx, actor) =>
        z
          .array(z.object({ id: z.uuid() }))
          .parse(
            (
              await tx.client.query(
                `SELECT b.id FROM ${batchTable(tx, 'batches')} b JOIN ${qualified(tx.schema, selectionTable(conversationId))} s ON s.${column}=b.${column} WHERE b.membership_id=$1 AND b.${column}=$2 AND b.account_id=s.account_id AND (b.snapshot->>'generation')::integer=s.account_generation AND (b.snapshot->>'selectionVersion')::integer=s.version ORDER BY b.created_at DESC LIMIT 20`,
                [actor.membershipId, contextId(conversationId)],
              )
            ).rows,
          ),
      );
      const batches = [];
      for (const { id } of ids) {
        try {
          batches.push(await read(workspaceId, userId, conversationId, id));
        } catch (error) {
          if (
            !(
              error instanceof AccessDenied ||
              error instanceof SourceAuthorizationUnavailable ||
              error instanceof GitHubBatchError
            )
          )
            throw error;
          batches.push(await this.status(workspaceId, userId, conversationId, id));
        }
      }
      return { batches };
    },
    async propose(
      workspaceId: string,
      actor: HumanActor,
      commandId: string,
      origin: ({ conversationId: string; turnId: string } | { taskId: string; callId: string; generation: number }) & {
        sources: readonly SourceDependency[];
      },
      input: unknown,
    ) {
      const context: GitHubContext = 'taskId' in origin ? { taskId: origin.taskId } : origin.conversationId;
      const value = githubBatchInputSchema.parse(input);
      for (const action of value.actions) if (action.kind === 'release.asset-upload') releaseUploadBytes(action);
      if (
        value.actions.some(
          action =>
            'body' in action &&
            (action.body.length > 15900 || (rejectsBodyMarker(action) && action.body.includes('<!-- tulipfarm:'))),
        )
      )
        throw new GitHubBatchError('batch-conflict');
      if (
        value.actions.some(
          action => isFileWrite(action) && (action.message.length > 900 || action.message.includes('<!-- tulipfarm:')),
        )
      )
        throw new GitHubBatchError('batch-conflict');
      return access(workspaceId, actor, context, async tx => {
        await requireGitHubSources(tx, [
          'taskId' in origin
            ? { kind: 'private-task', taskId: origin.taskId }
            : { kind: 'private-conversation', conversationId: origin.conversationId },
          ...origin.sources,
        ]);
        await batchLock(tx, actor.membershipId);
        const previous = (
          await tx.client.query(
            `SELECT id FROM ${batchTable(tx, 'batches')} WHERE membership_id=$1 AND command_id=$2`,
            [actor.membershipId, z.uuid().parse(commandId)],
          )
        ).rows[0];
        if (previous) {
          const row = await loadBatch(tx, actor, context, previous.id);
          const original = row.snapshot.actions.map(action =>
            isFileWrite(action)
              ? { ...action, message: action.message.replace(/\n\n<!-- tulipfarm:[a-f0-9-]+:\d+ -->$/, '') }
              : rejectsBodyMarker(action)
                ? { ...action, body: action.body.replace(/\n\n<!-- tulipfarm:[a-f0-9-]+:\d+ -->$/, '') }
                : action,
          );
          if (
            canonical(original) !== canonical(value.actions) ||
            (row.snapshot.origin.kind === 'chat'
              ? !('turnId' in origin) || row.snapshot.origin.turnId !== origin.turnId
              : !('callId' in origin) ||
                row.snapshot.origin.callId !== origin.callId ||
                row.snapshot.origin.generation !== origin.generation)
          )
            throw new GitHubBatchError('batch-conflict');
          await check(tx, actor, row.snapshot);
          return batchView(tx, row);
        }
        let batchOrigin;
        if ('taskId' in origin) {
          await requireGitHubTaskExecution(tx, actor, origin.taskId, origin.generation, 'github.personal.propose');
          batchOrigin = { kind: 'task', taskId: origin.taskId, callId: origin.callId, generation: origin.generation };
        } else {
          const turn = z
            .object({ generation: z.number().int().nonnegative() })
            .optional()
            .parse(
              (
                await tx.client.query(
                  `SELECT generation FROM ${qualified(tx.schema, 'tf_conversation_turns')} WHERE id=$1 AND conversation_id=$2 AND status='processing'`,
                  [origin.turnId, origin.conversationId],
                )
              ).rows[0],
            );
          if (!turn) throw new AccessDenied();
          await selectOnlyAccount(tx, actor, origin.conversationId);
          batchOrigin = {
            kind: 'chat',
            conversationId: origin.conversationId,
            turnId: origin.turnId,
            generation: turn.generation,
          };
        }
        const selection = z
          .object({ account_id: z.uuid(), account_generation: z.number(), version: z.number() })
          .safeParse(
            (
              await tx.client.query(
                `SELECT * FROM ${qualified(tx.schema, selectionTable(context))} WHERE ${contextColumn(context)}=$1`,
                [contextId(context)],
              )
            ).rows[0],
          );
        if (!selection.success) throw new GitHubBatchError('selection-required');
        const selected = selection.data;
        const count = z
          .number()
          .parse(
            (
              await tx.client.query(
                `SELECT count(*)::integer AS count FROM ${batchTable(tx, 'batches')} WHERE membership_id=$1 AND created_at>clock_timestamp()-interval '1 day'`,
                [actor.membershipId],
              )
            ).rows[0]?.count,
          );
        if (count >= 100) throw new GitHubBatchError('batch-conflict');
        if (
          (
            await tx.client.query(
              `SELECT 1 FROM ${batchTable(tx, 'action_receipts')} r JOIN ${batchTable(tx, 'batches')} b ON b.id=r.batch_id WHERE b.membership_id=$1 AND r.status='unknown'`,
              [actor.membershipId],
            )
          ).rowCount
        )
          throw new GitHubBatchError('batch-unresolved');
        const id = randomUUID();
        const expiresAt = z
          .date()
          .parse((await tx.client.query(`SELECT clock_timestamp()+interval '10 minutes' AS expiry`)).rows[0]?.expiry)
          .toISOString();
        const snapshot = batchSnapshotSchema.parse({
          id,
          workspaceId,
          membershipId: actor.membershipId,
          commandId,
          accountId: selected.account_id,
          generation: selected.account_generation,
          selectionVersion: selected.version,
          origin: batchOriginSchema.parse(batchOrigin),
          sources: sourceDependenciesSchema.parse(origin.sources),
          actions: value.actions.map((action, ordinal) =>
            isFileWrite(action)
              ? { ...action, message: `${action.message}\n\n<!-- tulipfarm:${id}:${ordinal} -->` }
              : [
                    'project.draft-create',
                    'discussion.create',
                    'discussion.comment-create',
                    'release.create',
                    'issue.create',
                    'issue.comment',
                    'pull.create',
                    'pull.create-fork',
                    'pull.comment',
                    'pull.review',
                  ].includes(action.kind) && 'body' in action
                ? { ...action, body: `${action.body}\n\n<!-- tulipfarm:${id}:${ordinal} -->` }
                : action,
          ),
          configurationDigest: writeConfiguration(bindings),
          expiresAt,
        });
        await options.requireSources(tx, actor, snapshot.sources);
        await tx.client.query(
          `INSERT INTO ${batchTable(tx, 'batches')} (id,membership_id,command_id,account_id,${contextColumn(context)},snapshot,digest,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            actor.membershipId,
            commandId,
            snapshot.accountId,
            contextId(context),
            snapshot,
            batchDigest(snapshot),
            expiresAt,
          ],
        );
        await check(tx, actor, snapshot);
        return batchView(tx, await loadBatch(tx, actor, context, id));
      });
    },
    async execute(
      workspaceId: string,
      principal: string | HumanActor,
      conversationId: GitHubContext,
      id: string,
      executionTurnId?: string,
    ) {
      const initial = await read(workspaceId, principal, conversationId, id);
      for (let ordinal = 0; ordinal < initial.snapshot.actions.length; ordinal++) {
        const claimed = await access(workspaceId, principal, conversationId, async (tx, actor) => {
          await batchLock(tx, actor.membershipId);
          const row = await loadBatch(tx, actor, conversationId, id);
          const view = await batchView(tx, row);
          const current = view.actions[ordinal];
          if (current?.status === 'succeeded') return { kind: 'completed' as const };
          if (!current || current.status !== 'unattempted') return { kind: 'stop' as const };
          if (view.actions.slice(0, ordinal).some(action => action.status !== 'succeeded'))
            return { kind: 'stop' as const };
          await freshBatch(tx, actor, row);
          await check(tx, actor, row.snapshot);
          if (row.snapshot.configurationDigest !== writeConfiguration(bindings))
            throw new GitHubBatchError('batch-conflict');
          if (view.decision !== 'approve') throw new GitHubBatchError('batch-approval-required');
          if (row.snapshot.origin.kind === 'task') {
            const taskId = row.snapshot.origin.taskId;
            const budget = await tx.client.query(
              `UPDATE ${qualified(tx.schema, 'tf_agent_tasks')} SET tool_calls=tool_calls+1 WHERE id=$1 AND tool_calls<(limits->>'toolCalls')::integer RETURNING id`,
              [taskId],
            );
            if (!budget.rowCount) throw new GitHubBatchError('batch-tool-limit');
          }
          if (
            (
              await tx.client.query(
                `SELECT 1 FROM ${batchTable(tx, 'action_receipts')} r JOIN ${batchTable(tx, 'batches')} b ON b.id=r.batch_id WHERE b.membership_id=$1 AND r.status='unknown'`,
                [actor.membershipId],
              )
            ).rowCount
          )
            throw new GitHubBatchError('batch-unresolved');
          const approved = row.snapshot.actions[ordinal];
          if (!approved) throw new GitHubBatchError('batch-conflict');
          const operation = receiptWrite(approved, view);
          await tx.client.query(`INSERT INTO ${batchTable(tx, 'action_receipts')} (batch_id,ordinal) VALUES ($1,$2)`, [
            id,
            ordinal,
          ]);
          if (!operation)
            await tx.client.query(
              `UPDATE ${batchTable(tx, 'action_receipts')} SET status='rejected' WHERE batch_id=$1 AND ordinal=$2 AND status='unknown'`,
              [id, ordinal],
            );
          return operation ? { kind: 'claimed' as const, actor, row, operation } : { kind: 'stop' as const };
        });
        if (claimed.kind === 'completed') continue;
        if (claimed.kind === 'stop') break;
        const operation = claimed.operation;
        let outcome: WriteOutcome = { status: 'unknown', result: null };
        let attempted = false;
        try {
          const preparedFile =
            operation.kind === 'files.commit'
              ? await options.accounts.withCredential(
                  workspaceId,
                  claimed.actor,
                  claimed.row.snapshot.accountId,
                  async (credential, tx) => {
                    const fetcher = executionFetch(tx, claimed.actor, claimed.row.snapshot);
                    await freshBatch(tx, claimed.actor, await loadBatch(tx, claimed.actor, conversationId, id));
                    await check(tx, claimed.actor, claimed.row.snapshot);
                    return prepareFileCommit({
                      operation,
                      credential,
                      fetcher,
                      authorize: async () => {
                        await freshBatch(tx, claimed.actor, await loadBatch(tx, claimed.actor, conversationId, id));
                        return true;
                      },
                    });
                  },
                  claimed.row.snapshot.generation,
                  (tx, actor) => requireGitHubOrigin(tx, actor, conversationId),
                )
              : undefined;
          if (preparedFile)
            await options.runtime.transaction(workspaceId, batchRange, async tx => {
              const saved = await tx.client.query(
                `UPDATE ${batchTable(tx, 'action_receipts')} SET reconciliation=$3 WHERE batch_id=$1 AND ordinal=$2 AND status='unknown' AND reconciliation IS NULL`,
                [id, ordinal, preparedFile],
              );
              if (saved.rowCount !== 1) throw new GitHubBatchError('batch-conflict');
            });
          outcome = await options.accounts.withCredential(
            workspaceId,
            claimed.actor,
            claimed.row.snapshot.accountId,
            async (credential, tx) => {
              const fetcher = executionFetch(tx, claimed.actor, claimed.row.snapshot);
              await freshBatch(tx, claimed.actor, await loadBatch(tx, claimed.actor, conversationId, id));
              if (
                executionTurnId &&
                !(
                  await tx.client.query(
                    `SELECT 1 FROM ${qualified(tx.schema, 'tf_conversation_turns')} WHERE id=$1 AND conversation_id=$2 AND status='processing' FOR SHARE`,
                    [executionTurnId, conversationId],
                  )
                ).rowCount
              )
                throw new GitHubBatchError('batch-conflict');
              await check(tx, claimed.actor, claimed.row.snapshot);
              try {
                await requireWriteTarget(operation, credential, fetcher, true);
              } catch (error) {
                if (error instanceof GitHubBatchError && error.code === 'batch-conflict')
                  return { status: 'rejected', result: null };
                throw error;
              }
              if (
                !(
                  await tx.client.query(
                    `SELECT 1 FROM ${batchTable(tx, 'action_receipts')} WHERE batch_id=$1 AND ordinal=$2 AND status='unknown' AND reconciliation IS NOT DISTINCT FROM $3::jsonb`,
                    [id, ordinal, preparedFile ?? null],
                  )
                ).rowCount
              )
                throw new GitHubBatchError('batch-conflict');
              attempted = !isFileWrite(operation);
              return dispatchGitHubWrite({
                operation,
                credential,
                bindings,
                fetcher,
                ...(preparedFile ? { preparedFile } : {}),
                beforeVisibleWrite: async () => {
                  attempted = true;
                },
                authorize: async () => {
                  await freshBatch(tx, claimed.actor, await loadBatch(tx, claimed.actor, conversationId, id));
                  return true;
                },
              });
            },
            claimed.row.snapshot.generation,
            (tx, actor) => requireGitHubOrigin(tx, actor, conversationId),
          );
          await options.runtime.transaction(workspaceId, batchRange, async tx => {
            await tx.client.query(
              `UPDATE ${batchTable(tx, 'action_receipts')} SET status=$3,result=$4 WHERE batch_id=$1 AND ordinal=$2 AND status='unknown'`,
              [id, ordinal, outcome.status, outcome.result],
            );
          });
        } catch {
          if (
            !attempted &&
            (isProjectWrite(operation) ||
              isDiscussionWrite(operation) ||
              isActionsWrite(operation) ||
              isReleaseWrite(operation) ||
              isRepositoryWrite(operation) ||
              isFileWrite(operation) ||
              operation.kind === 'pull.create-fork')
          )
            await options.runtime.transaction(workspaceId, batchRange, async tx => {
              await tx.client.query(
                `UPDATE ${batchTable(tx, 'action_receipts')} SET status='rejected',result=NULL WHERE batch_id=$1 AND ordinal=$2 AND status='unknown'`,
                [id, ordinal],
              );
            });
          break;
        }
        if (outcome.status !== 'succeeded') break;
      }
      return read(workspaceId, principal, conversationId, id);
    },
    async reconcile(workspaceId: string, userId: string, conversationId: GitHubContext, id: string) {
      const view = await read(workspaceId, userId, conversationId, id);
      const action = view.actions.find(item => item.status === 'unknown');
      if (!action) return view;
      const operation = view.snapshot.actions[action.ordinal];
      if (!operation) throw new GitHubBatchError('batch-conflict');
      return options.accounts.withCredential(
        workspaceId,
        userId,
        view.snapshot.accountId,
        async (credential, tx) => {
          const actor = { kind: 'human' as const, userId, membershipId: view.snapshot.membershipId };
          await check(tx, actor, view.snapshot);
          const current = receiptWrite(operation, view);
          if (!current) throw new GitHubBatchError('batch-conflict');
          const evidence = await reconcileGitHubWrite({
            operation: current,
            credential,
            fetcher,
            marker: `<!-- tulipfarm:${id}:${action.ordinal} -->`,
            previousEvidence: action.reconciliation,
          });
          await tx.client.query(
            `UPDATE ${batchTable(tx, 'action_receipts')} SET status=$3,result=$4,reconciliation=$5 WHERE batch_id=$1 AND ordinal=$2 AND status='unknown'`,
            [id, action.ordinal, evidence.result ? 'succeeded' : 'unknown', evidence.result, evidence.evidence],
          );
          return batchView(tx, await loadBatch(tx, actor, conversationId, id));
        },
        view.snapshot.generation,
        (tx, actor) => requireGitHubOrigin(tx, actor, conversationId),
      );
    },
    async reconcileStatus(workspaceId: string, userId: string, conversationId: GitHubContext, id: string) {
      const prepared = await access(workspaceId, userId, conversationId, async (tx, actor) => {
        const row = await loadBatch(tx, actor, conversationId, id);
        await requirePersonalGitHubSelection(tx, actor, selectionSource(row.snapshot));
        return { actor, view: await batchView(tx, row) };
      });
      const action = prepared.view.actions.find(action => action.status === 'unknown');
      const operation = action && prepared.view.snapshot.actions[action.ordinal];
      if (
        action &&
        operation &&
        (isProjectWrite(operation) ||
          isDiscussionWrite(operation) ||
          isActionsWrite(operation) ||
          isReleaseWrite(operation) ||
          isRepositoryWrite(operation) ||
          isFileWrite(operation))
      )
        await options.accounts.withCredential(
          workspaceId,
          prepared.actor,
          prepared.view.snapshot.accountId,
          async (credential, tx) => {
            await requirePersonalGitHubSelection(tx, prepared.actor, selectionSource(prepared.view.snapshot));
            const current = receiptWrite(operation, prepared.view);
            if (!current) throw new GitHubBatchError('batch-conflict');
            const evidence = await reconcileGitHubWrite({
              operation: current,
              credential,
              fetcher,
              marker: `<!-- tulipfarm:${id}:${action.ordinal} -->`,
              previousEvidence: action.reconciliation,
            });
            await tx.client.query(
              `UPDATE ${batchTable(tx, 'action_receipts')} SET status=$3,result=$4,reconciliation=$5 WHERE batch_id=$1 AND ordinal=$2 AND status='unknown'`,
              [id, action.ordinal, evidence.result ? 'succeeded' : 'unknown', evidence.result, evidence.evidence],
            );
          },
          prepared.view.snapshot.generation,
          (tx, actor) => requireGitHubOrigin(tx, actor, conversationId),
        );
      return this.status(workspaceId, userId, conversationId, id);
    },
  };
}
