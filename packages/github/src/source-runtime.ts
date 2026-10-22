import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  requireProtectedSource,
  SourceAuthorizationUnavailable,
  type AuthorizationTransaction,
} from '@tulipfarm/access';
import { createGitHubBatches } from './batches.ts';
import { githubWriteBindings } from './write-provider.ts';
import { batchTable, batchView, loadBatch } from './batch-store.ts';
import { receiptSource } from './batch-source-receipts.ts';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createGitHubAccounts, type AccountRuntime } from './accounts.ts';
import { dispatchGitHubRead, githubRateLimited } from './read-provider.ts';
import { githubRuntimeConfiguration } from './configuration.ts';
import { downloadMetadataOperation, downloadIdentity } from './download-provider.ts';
import { githubReadSchema, GitHubReadError } from './read-contracts.ts';
import { hasFixedAccessTarget } from './source-access.ts';
import { discussionSourceIdentity } from './discussion-source.ts';
import { projectSourceIdentity, projectSourceOperation } from './project-source.ts';
import { checkDeletedProjectOwner } from './project-writes.ts';
import { projectReader } from './write-provider.ts';
import { createTeamGitHubSourceCheck } from './team-reads.ts';

export type GitHubSourceFailure =
  | 'github-rate-limited'
  | 'github-unavailable'
  | 'source-access-revoked'
  | 'source-changed';
// Reverification could not reach GitHub, so the source stays refused but the denial is not evidence of revoked access.
export class GitHubSourceUnavailable extends SourceAuthorizationUnavailable {
  readonly code: Extract<GitHubSourceFailure, 'github-rate-limited' | 'github-unavailable'>;
  constructor(code: GitHubSourceUnavailable['code']) {
    super();
    this.code = code;
  }
}
export class GitHubSourceDenied extends AccessDenied {
  readonly code: Extract<GitHubSourceFailure, 'source-access-revoked' | 'source-changed'>;
  constructor(code: GitHubSourceDenied['code']) {
    super();
    this.code = code;
  }
}
export const githubSourceDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function withGitHubSourceAuthorization<T extends AccountRuntime>(
  runtime: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const { oauth: configuration, readBindings: bindings } = githubRuntimeConfiguration(env);
  const keyring = configuration ? integrationCredentialKeyring(env) : null;
  return {
    ...runtime,
    transaction: (workspaceId, range, operation) =>
      runtime.transaction(workspaceId, range, async tx => {
        const bound: AccountRuntime = {
          transaction: async (workspace, compatibility, action) => {
            if (
              workspace !== workspaceId ||
              tx.commonVersion < compatibility.minimum ||
              tx.commonVersion > compatibility.maximum
            )
              throw new AccessDenied();
            return action(tx);
          },
        };
        const accounts = createGitHubAccounts({ runtime: bound, configuration, keyring });
        const checked = new Set<string>();
        let attempts = 0;
        const deadline = Date.now() + 10000;
        const check =
          (mode: 'snapshot' | 'access'): NonNullable<AuthorizationTransaction['requireGitHubSource']> =>
          async (actor, source) => {
            const key = JSON.stringify([mode, actor, source]);
            if (Date.now() >= deadline) throw new GitHubSourceUnavailable('github-unavailable');
            if (checked.has(key)) return;
            if (source.origin === 'task' && source.proof && mode === 'snapshot') {
              const rows = await tx.client.query(
                `SELECT id FROM ${batchTable(tx, 'batches')} WHERE task_id=$1 AND membership_id=$2 AND account_id=$3 AND snapshot->'sources' @> $4::jsonb ORDER BY created_at,id LIMIT 101`,
                [source.taskId, actor.membershipId, source.accountId, JSON.stringify([source])],
              );
              if (rows.rows.length > 100) throw new SourceAuthorizationUnavailable();
              let current: typeof source | null = source;
              let changed = false;
              for (const row of rows.rows) {
                const view = await batchView(
                  tx,
                  await loadBatch(tx, actor, { taskId: source.taskId }, z.uuid().parse(row.id)),
                );
                if (!view.actions.some(action => action.status === 'succeeded')) continue;
                changed = true;
                const next: ReturnType<typeof receiptSource> = current && receiptSource(current, view);
                if (next && next.origin !== 'task') throw new AccessDenied();
                current = next;
              }
              if (changed) {
                if (current) await check('access')(actor, current);
                checked.add(key);
                return;
              }
            }
            if (source.origin === 'task' && source.batchId) {
              if (attempts++ >= 32) throw new SourceAuthorizationUnavailable();
              const batchRuntime: AccountRuntime = {
                transaction: (workspace, compatibility, action) =>
                  bound.transaction(workspace, compatibility, local => {
                    const guarded = {
                      ...local,
                      requireGitHubSource: check('snapshot'),
                      requireGitHubSourceAccess: check('access'),
                    };
                    return action(guarded);
                  }),
              };
              const batch = await createGitHubBatches({
                runtime: batchRuntime,
                accounts: createGitHubAccounts({ runtime: batchRuntime, configuration, keyring }),
                bindings: githubWriteBindings(env),
                requireSources: async (local, owner, sources) => {
                  for (const dependency of sources) await requireProtectedSource(local, owner, dependency);
                },
              }).read(workspaceId, actor, { taskId: source.taskId }, source.batchId);
              if (
                batch.snapshot.accountId !== source.accountId ||
                batch.snapshot.generation !== source.generation ||
                batch.snapshot.selectionVersion !== source.selectionVersion
              )
                throw new AccessDenied();
              checked.add(key);
              return;
            }
            if (!source.proof) throw new AccessDenied();
            if (attempts++ >= 32) throw new SourceAuthorizationUnavailable();
            const proof = source.proof;
            // Search pages carry volatile metadata (pushed_at, size, score), so a pinned search proves access by rereading its original targets.
            const pinnedSearch = proof.transport === 'rest' && proof.accessTargets !== undefined && !proof.download;
            if (
              proof.transport === 'official-mcp' &&
              !bindings.some(binding => binding.operation === proof.operation.kind)
            )
              throw new AccessDenied();
            let transient: GitHubSourceUnavailable['code'] | null = null;
            try {
              const output = await accounts.withCredential(
                workspaceId,
                actor,
                source.accountId,
                async credential => {
                  const fetcher: typeof fetch = async (url, init) => {
                    let response: Response;
                    try {
                      response = await fetch(url, {
                        ...init,
                        signal: AbortSignal.any([
                          AbortSignal.timeout(Math.max(1, deadline - Date.now())),
                          ...(init?.signal ? [init.signal] : []),
                        ]),
                      });
                    } catch (error) {
                      transient ??= 'github-unavailable';
                      throw error;
                    }
                    if (githubRateLimited(response)) transient = 'github-rate-limited';
                    else if (response.status >= 500) transient ??= 'github-unavailable';
                    return response;
                  };
                  if (proof.projectList) {
                    if (proof.operation.kind !== 'project.list' || proof.transport !== 'graphql')
                      throw new AccessDenied();
                    const output = await dispatchGitHubRead({
                      operation: { ...proof.operation, perPage: 1 },
                      credential,
                      bindings: [],
                      fetcher,
                    });
                    z.object({ ownerIdentity: z.object({ id: z.literal(proof.projectList.ownerNodeId) }) }).parse(
                      output.data,
                    );
                    for (const identity of proof.projectList.projects) {
                      if (attempts++ >= 32) throw new AccessDenied();
                      if (identity.deleted)
                        await checkDeletedProjectOwner(identity, credential, projectReader(credential, fetcher));
                      else {
                        const current = await dispatchGitHubRead({
                          operation: {
                            kind: 'project.read',
                            owner: identity.owner,
                            ownerType: identity.ownerType,
                            number: identity.projectNumber,
                          },
                          credential,
                          bindings: [],
                          fetcher,
                        });
                        z.object({
                          id: z.literal(identity.projectId),
                          owner: z.object({ id: z.literal(identity.ownerNodeId) }),
                        }).parse(current.data);
                      }
                    }
                    return output;
                  }
                  if (proof.projectIdentity) {
                    const identity = proof.projectIdentity;
                    if (proof.transport !== 'graphql') throw new AccessDenied();
                    for (const repository of identity.repositories) {
                      if (attempts++ >= 32) throw new AccessDenied();
                      const [owner, repo] = repository.nameWithOwner.split('/');
                      const operation = githubReadSchema.parse({ kind: 'repository.read', owner, repo });
                      const output = await dispatchGitHubRead({ operation, credential, bindings: [], fetcher });
                      z.object({
                        id: z.literal(repository.databaseId),
                        node_id: z.literal(repository.id),
                        owner: z.object({ node_id: z.literal(repository.owner.id) }),
                      }).parse(output.data);
                    }
                    if (identity.deleted) {
                      await checkDeletedProjectOwner(identity, credential, projectReader(credential, fetcher));
                      return { transport: 'graphql' as const, data: { deletedProjectReceipt: true } };
                    }
                    const operation = projectSourceOperation(source);
                    if (!operation) throw new AccessDenied();
                    const output = await dispatchGitHubRead({ operation, credential, bindings: [], fetcher });
                    const current = projectSourceIdentity(operation, output.data);
                    if (
                      !current ||
                      current.projectId !== identity.projectId ||
                      current.ownerNodeId !== identity.ownerNodeId ||
                      current.ownerType !== identity.ownerType ||
                      current.projectNumber !== identity.projectNumber
                    )
                      throw new AccessDenied();
                    return output;
                  }
                  if (pinnedSearch && proof.accessTargets) {
                    for (const operation of proof.accessTargets) {
                      if (!hasFixedAccessTarget(operation) || attempts++ >= 32) throw new AccessDenied();
                      await dispatchGitHubRead({ operation, credential, bindings: [], fetcher });
                    }
                  }
                  return dispatchGitHubRead({
                    operation: proof.operation,
                    credential,
                    bindings: proof.transport === 'official-mcp' ? bindings : [],
                    fetcher,
                  });
                },
                source.generation,
              );
              const data = proof.download ? downloadIdentity(proof.download.operation, output.data) : output.data;
              if (proof.discussionIdentity) {
                if (proof.operation.kind === 'repository.read') {
                  z.object({
                    id: z.literal(proof.discussionIdentity.repositoryId),
                    node_id: z.literal(proof.discussionIdentity.repositoryNodeId),
                    owner: z.object({ node_id: z.literal(proof.discussionIdentity.ownerNodeId) }),
                  }).parse(output.data);
                } else {
                  const identity = discussionSourceIdentity(proof.operation, output.data);
                  if (
                    !identity ||
                    identity.discussionId !== proof.discussionIdentity.discussionId ||
                    identity.repositoryId !== proof.discussionIdentity.repositoryId ||
                    identity.repositoryNodeId !== proof.discussionIdentity.repositoryNodeId ||
                    identity.ownerNodeId !== proof.discussionIdentity.ownerNodeId
                  )
                    throw new AccessDenied();
                }
              }
              const fixedAccess =
                pinnedSearch ||
                (!proof.download &&
                  (proof.projectList !== undefined ||
                    proof.projectIdentity !== undefined ||
                    hasFixedAccessTarget(proof.operation)));
              if (output.transport !== proof.transport) throw new AccessDenied();
              if (!fixedAccess && githubSourceDigest(data) !== proof.digest)
                throw new GitHubSourceDenied('source-changed');
              if (Date.now() >= deadline) throw new GitHubSourceUnavailable('github-unavailable');
              if (proof.download) {
                if (
                  proof.transport !== 'rest' ||
                  JSON.stringify(githubReadSchema.parse(downloadMetadataOperation(proof.download.operation))) !==
                    JSON.stringify(githubReadSchema.parse(proof.operation))
                )
                  throw new AccessDenied();
              }
              checked.add(key);
            } catch (error) {
              if (transient) throw new GitHubSourceUnavailable(transient);
              if (error instanceof GitHubReadError && error.code === 'read-rate-limited')
                throw new GitHubSourceUnavailable('github-rate-limited');
              if (error instanceof GitHubSourceDenied || error instanceof GitHubSourceUnavailable) throw error;
              if (Date.now() >= deadline) throw new GitHubSourceUnavailable('github-unavailable');
              throw new GitHubSourceDenied('source-access-revoked');
            }
          };
        let teamSourceCheck: ReturnType<typeof createTeamGitHubSourceCheck> | undefined;
        const guarded: typeof tx & AuthorizationTransaction = {
          ...tx,
          requireGitHubSource: check('snapshot'),
          requireGitHubSourceAccess: check('access'),
          requireTeamGitHubSource: (actor, source) => {
            teamSourceCheck ??= createTeamGitHubSourceCheck({
              runtime: bound,
              workspaceId,
              keyring: keyring ?? integrationCredentialKeyring(env),
            });
            return teamSourceCheck(actor, source);
          },
        };
        return operation(guarded);
      }),
  };
}
