import { z } from 'zod';
import {
  AccessDenied,
  canAccessAsset,
  currentMember,
  lockAuthorization,
  SourceAuthorizationUnavailable,
  type HumanActor,
} from '@tulipfarm/access';
import {
  githubInvestigationPermissionSchema,
  githubInvestigationPermissions,
} from '@tulipfarm/access/github-investigation';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { credentialCipher, type IntegrationKeyring } from '@tulipfarm/integrations/credentials';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { GitHubCredentialRejected, type AccountRuntime } from './accounts.ts';
import { githubReadSchema, GitHubReadError } from './read-contracts.ts';
import { dispatchGitHubRead, githubRateLimited } from './read-provider.ts';

const sourceSchema = z.object({
  kind: z.literal('github-source'),
  integrationId: uuidSchema,
  sourceId: uuidSchema,
  generation: z.number().int().positive(),
  grantsVersion: z.number().int().positive(),
  requiredPermissions: z.array(githubInvestigationPermissionSchema).min(1).max(6),
  readProof: z.object({ operation: githubReadSchema, accessTargets: z.array(githubReadSchema).max(30).optional() }),
});

export function createTeamGitHubSourceCheck(options: {
  runtime: AccountRuntime;
  workspaceId: string;
  keyring?: IntegrationKeyring;
  fetcher?: typeof fetch;
}) {
  const cipher = credentialCipher(options.keyring);
  const checked = new Set<string>();
  const deadline = Date.now() + 10000;
  let requests = 0;
  return async (actor: HumanActor, input: unknown) => {
    const source = sourceSchema.parse(input);
    const key = JSON.stringify([actor, source]);
    if (Date.now() >= deadline) throw new SourceAuthorizationUnavailable();
    if (checked.has(key)) return;
    await options.runtime.transaction(options.workspaceId, { ...commonCompatibility, minimum: 1 }, async tx => {
      await lockAuthorization(tx);
      await currentMember(tx, actor);
      if (!(await canAccessAsset(tx, actor, source.integrationId, 'integration.use'))) throw new AccessDenied();
      for (const permission of source.requiredPermissions)
        if (!(await canAccessAsset(tx, actor, source.sourceId, permission))) throw new AccessDenied();
      const table = (name: string) => qualified(tx.schema, name);
      const row = z
        .object({ owner: z.string(), repo: z.string(), credential: z.unknown() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT s.owner,s.repo,c.credential FROM ${table('tf_integrations')} c JOIN ${table('tf_integration_sources')} s ON s.integration_id=c.id
         WHERE c.id=$1 AND s.id=$2 AND c.generation=$3 AND c.grants_version=$4 AND c.enabled AND c.deleted_at IS NULL AND c.credential IS NOT NULL FOR SHARE OF c`,
              [source.integrationId, source.sourceId, source.generation, source.grantsVersion],
            )
          ).rows[0],
        );
      if (!row) throw new AccessDenied();
      const original = source.readProof.operation;
      if (original.kind.startsWith('project.')) throw new AccessDenied();
      if (original.kind !== 'repository.read') {
        for (const permission of githubInvestigationPermissions(original))
          if (!source.requiredPermissions.includes(permission)) throw new AccessDenied();
      }
      const targets = source.readProof.accessTargets ?? [original];
      const scopedTargets = targets.length
        ? targets
        : [githubReadSchema.parse({ kind: 'repository.read', owner: row.owner, repo: row.repo })];
      const accessToken = cipher.decrypt(options.workspaceId, source.integrationId, source.generation, row.credential);
      for (const operation of scopedTargets) {
        if (
          !('repo' in operation) ||
          operation.owner.toLowerCase() !== row.owner.toLowerCase() ||
          operation.repo.toLowerCase() !== row.repo.toLowerCase()
        )
          throw new AccessDenied();
        if (source.readProof.accessTargets) {
          const familyAllowed =
            original.kind === 'file.search'
              ? operation.kind === 'file.read'
              : original.kind === 'issue.search' || original.kind === 'pull.search'
                ? operation.kind === 'issue.read' || operation.kind === 'pull.read'
                : original.kind === 'discussion.search'
                  ? operation.kind === 'discussion.read'
                  : original.kind === 'repository.search' && operation.kind === 'repository.read';
          if (targets.length && !familyAllowed) throw new AccessDenied();
        }
        const reads =
          operation.kind === 'issue.comments'
            ? [
                githubReadSchema.parse({
                  kind: 'issue.read',
                  owner: operation.owner,
                  repo: operation.repo,
                  number: operation.number,
                }),
                operation,
              ]
            : [operation];
        let unavailable = false;
        try {
          for (const read of reads) {
            const output = await dispatchGitHubRead({
              operation: read,
              credential: { accessToken },
              bindings: [],
              fetcher: async (url, init) => {
                if (++requests > 32 || Date.now() >= deadline) throw new SourceAuthorizationUnavailable();
                let response: Response;
                try {
                  response = await (options.fetcher ?? fetch)(url, {
                    ...init,
                    signal: AbortSignal.any([
                      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
                      ...(init?.signal ? [init.signal] : []),
                    ]),
                  });
                } catch (error) {
                  unavailable = true;
                  throw error;
                }
                unavailable ||= githubRateLimited(response) || response.status >= 500;
                return response;
              },
            });
            if (read.kind === 'issue.read' && original.kind !== 'pull.search') {
              const issue = z
                .object({ number: z.literal(read.number) })
                .passthrough()
                .safeParse(output.data);
              if (!issue.success) throw new SourceAuthorizationUnavailable();
              if ('pull_request' in issue.data) throw new AccessDenied();
            }
          }
        } catch (error) {
          if (unavailable || Date.now() >= deadline || requests > 32 || error instanceof SourceAuthorizationUnavailable)
            throw new SourceAuthorizationUnavailable();
          if (
            error instanceof GitHubCredentialRejected ||
            (error instanceof GitHubReadError && error.code === 'read-forbidden')
          )
            throw new AccessDenied();
          if (error instanceof GitHubReadError) throw new SourceAuthorizationUnavailable();
          throw error;
        }
      }
    });
    checked.add(key);
  };
}
