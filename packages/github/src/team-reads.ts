import { z } from 'zod';
import {
  AccessDenied,
  canAccessAsset,
  currentMember,
  denyMcpEgress,
  lockAuthorization,
  requireGitHubTaskExecution,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import {
  githubInvestigationPermissionSchema,
  githubInvestigationPermissions,
  type GitHubInvestigationPermission,
} from '@tulipfarm/access/github-investigation';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { credentialCipher, type IntegrationKeyring } from '@tulipfarm/integrations/credentials';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { GitHubCredentialRejected, type AccountRuntime } from './accounts.ts';
import { githubReadSchema, GitHubReadError, type GitHubRead } from './read-contracts.ts';
import { dispatchGitHubRead } from './read-provider.ts';
import { requireGitHubOrigin, requireGitHubSources } from './origin.ts';
import { searchAccessTargets } from './source-access.ts';
import {
  teamGitHubReadBindingSchema,
  teamGitHubRepositoryQuerySchema,
  type TeamGitHubReadBinding,
} from './team-read-contracts.ts';
export { createTeamGitHubSourceCheck } from './team-source.ts';

const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const repositorySchema = z.object({ id: z.uuid(), owner: z.string(), repo: z.string() });
type Repository = z.infer<typeof repositorySchema>;
const integrationSchema = z.object({
  generation: z.number().int().positive(),
  grants_version: z.number().int().positive(),
  credential: z.unknown(),
});
type Integration = z.infer<typeof integrationSchema>;
const compatibility = { ...commonCompatibility, minimum: 1 };
const sameRepository = (source: Repository, owner: string, repo: string) =>
  source.owner.toLowerCase() === owner.toLowerCase() && source.repo.toLowerCase() === repo.toLowerCase();

export function scopeTeamGitHubSearch(operation: GitHubRead, source: Repository): GitHubRead {
  if (!('query' in operation) || operation.query === undefined) return operation;
  if (
    /[\r\n()]/.test(operation.query) ||
    /(?:^|\s)(?:-?(?:repo|org|user|owner|is|type):|(?:OR|NOT|AND)(?:\s|$))/i.test(operation.query)
  )
    throw new GitHubReadError('read-unqualified');
  const family = operation.kind === 'issue.search' ? ' is:issue' : operation.kind === 'pull.search' ? ' is:pr' : '';
  const query = `${operation.query} repo:${source.owner}/${source.repo}${family}`;
  if (query.length > 256) throw new GitHubReadError('read-limit');
  return githubReadSchema.parse({ ...operation, query });
}

function checkSearchResults(operation: GitHubRead, source: Repository, data: unknown) {
  if (operation.kind === 'discussion.search') {
    const page = z
      .object({ nodes: z.array(z.object({ repository: z.object({ nameWithOwner: z.string() }) })).max(30) })
      .safeParse(data);
    if (
      !page.success ||
      page.data.nodes.some(
        node => node.repository.nameWithOwner.toLowerCase() !== `${source.owner}/${source.repo}`.toLowerCase(),
      )
    )
      throw new GitHubReadError('read-forbidden');
  } else if (['file.search', 'issue.search', 'pull.search'].includes(operation.kind)) {
    const targets = searchAccessTargets(operation, data);
    if (
      !targets ||
      ('perPage' in operation && targets.length > operation.perPage) ||
      targets.some(target => !('repo' in target) || !sameRepository(source, target.owner, target.repo))
    )
      throw new GitHubReadError('read-forbidden');
    if (operation.kind === 'issue.search' || operation.kind === 'pull.search') {
      const page = z.object({ items: z.array(z.object({ is_pull_request: z.boolean() })).max(30) }).safeParse(data);
      if (!page.success || page.data.items.some(item => item.is_pull_request !== (operation.kind === 'pull.search')))
        throw new GitHubReadError('read-forbidden');
    }
  }
}

function checkIssue(data: unknown, number: number) {
  const issue = z
    .object({ number: z.literal(number) })
    .passthrough()
    .safeParse(data);
  if (!issue.success) throw new GitHubReadError('read-unavailable');
  if ('pull_request' in issue.data) throw new GitHubReadError('read-forbidden');
}

export function createTeamGitHubReads(options: {
  runtime: AccountRuntime;
  keyring?: IntegrationKeyring;
  fetcher?: typeof fetch;
}) {
  const cipher = credentialCipher(options.keyring);
  async function authorized<T>(
    workspaceId: string,
    actor: HumanActor,
    binding: TeamGitHubReadBinding,
    tool: string,
    action: (tx: AuthorizationTransaction, integration: Integration) => Promise<T>,
  ) {
    return options.runtime.transaction(uuidSchema.parse(workspaceId), compatibility, async tx => {
      await lockAuthorization(tx);
      await currentMember(tx, actor);
      if (binding.membershipId !== actor.membershipId) throw new AccessDenied();
      const origin = binding.origin;
      await requireGitHubOrigin(tx, actor, origin.kind === 'chat' ? origin.conversationId : { taskId: origin.taskId });
      if (origin.kind === 'task') {
        await requireGitHubTaskExecution(tx, actor, origin.taskId, origin.generation, tool);
        await requireGitHubSources(tx, [{ kind: 'private-task', taskId: origin.taskId }]);
      } else {
        await requireGitHubSources(tx, [{ kind: 'private-conversation', conversationId: origin.conversationId }]);
        if (
          !(
            await tx.client.query(
              `SELECT 1 FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$1 AND conversation_id=$2 AND status='processing'`,
              [origin.turnId, origin.conversationId],
            )
          ).rowCount
        )
          throw new AccessDenied();
      }
      const selection = origin.kind === 'chat' ? 'tf_github_chat_selection' : 'tf_github_task_selection';
      const column = origin.kind === 'chat' ? 'conversation_id' : 'task_id';
      const contextId = origin.kind === 'chat' ? origin.conversationId : origin.taskId;
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, selection)} WHERE ${column}=$1 AND integration_id=$2 AND integration_generation=$3 AND version=$4 AND investigation AND account_id IS NULL FOR SHARE`,
            [contextId, binding.integrationId, binding.generation, binding.selectionVersion],
          )
        ).rowCount
      )
        throw new GitHubReadError('selection-conflict');
      if (!(await canAccessAsset(tx, actor, binding.integrationId, 'integration.use'))) throw new AccessDenied();
      const integration = integrationSchema
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT generation,grants_version,credential FROM ${table(tx, 'tf_integrations')} WHERE id=$1 AND generation=$2 AND enabled AND deleted_at IS NULL AND credential IS NOT NULL FOR SHARE`,
              [binding.integrationId, binding.generation],
            )
          ).rows[0],
        );
      if (!integration) throw new AccessDenied();
      return action(tx, integration);
    });
  }
  function evidence(
    binding: TeamGitHubReadBinding,
    integration: Integration,
    source: Repository,
    requiredPermissions: readonly GitHubInvestigationPermission[],
    readProof: { operation: GitHubRead; accessTargets?: GitHubRead[] } = {
      operation: { kind: 'repository.read', owner: source.owner, repo: source.repo },
    },
  ) {
    const origin =
      binding.origin.kind === 'chat'
        ? { kind: 'chat' as const, conversationId: binding.origin.conversationId }
        : { kind: 'task' as const, taskId: binding.origin.taskId, generation: binding.origin.generation };
    return {
      kind: 'github-source' as const,
      integrationId: binding.integrationId,
      sourceId: source.id,
      generation: integration.generation,
      grantsVersion: integration.grants_version,
      requiredPermissions: [...requiredPermissions],
      readProof,
      investigation: { membershipId: binding.membershipId, selectionVersion: binding.selectionVersion, origin },
    };
  }
  async function requirePermissions(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    sourceId: string,
    permissions: readonly GitHubInvestigationPermission[],
  ) {
    for (const permission of permissions)
      if (!(await canAccessAsset(tx, actor, sourceId, permission))) throw new AccessDenied();
  }
  async function repositories(
    workspaceId: string,
    actor: HumanActor,
    inputBinding: TeamGitHubReadBinding,
    input: z.input<typeof teamGitHubRepositoryQuerySchema> = {},
    tool = 'github.investigation.repositories',
  ) {
    denyMcpEgress();
    const binding = teamGitHubReadBindingSchema.parse(inputBinding);
    const query = teamGitHubRepositoryQuerySchema.parse(input);
    return authorized(workspaceId, actor, binding, tool, async (tx, integration) => {
      const start = (query.page - 1) * query.perPage;
      const rows = z
        .array(repositorySchema.extend({ permissions: z.array(githubInvestigationPermissionSchema).min(1).max(6) }))
        .max(31)
        .parse(
          (
            await tx.client.query(
              `SELECT s.id,s.owner,s.repo,array_agg(DISTINCT g.permission ORDER BY g.permission) AS permissions
           FROM ${table(tx, 'tf_integration_sources')} s JOIN (
             SELECT source_id,permission FROM ${table(tx, 'tf_integration_source_person_grants')}
               WHERE integration_id=$1 AND membership_id=$2 AND permission=ANY($3::text[])
             UNION
             SELECT g.source_id,g.permission FROM ${table(tx, 'tf_integration_source_grants')} g
               JOIN ${table(tx, 'tf_member_teams')} mt ON mt.team_id=g.team_id
               WHERE g.integration_id=$1 AND mt.membership_id=$2 AND g.permission=ANY($3::text[])
           ) g ON g.source_id=s.id
           WHERE s.integration_id=$1 AND ($4::text IS NULL OR strpos(lower(s.owner||'/'||s.repo),lower($4))>0)
           GROUP BY s.id,s.owner,s.repo ORDER BY lower(s.owner),lower(s.repo),s.id LIMIT $5 OFFSET $6`,
              [
                binding.integrationId,
                actor.membershipId,
                githubInvestigationPermissionSchema.options,
                query.query ?? null,
                query.perPage + 1,
                start,
              ],
            )
          ).rows,
        );
      const selected = rows.slice(0, query.perPage);
      return {
        result: {
          provider: 'github-team',
          untrusted: true,
          repositories: selected.map(source => ({
            sourceId: source.id,
            owner: source.owner,
            repo: source.repo,
            permissions: source.permissions,
          })),
          nextPage: rows.length > query.perPage ? query.page + 1 : null,
          scope:
            'Configured repositories with current investigation grants on the selected team integration. This is not a global GitHub repository search.',
        },
        sources: selected.map(source => {
          const permission = source.permissions[0];
          if (!permission) throw new AccessDenied();
          return evidence(binding, integration, source, [permission]);
        }),
      };
    });
  }
  return {
    repositories: (
      workspaceId: string,
      actor: HumanActor,
      binding: TeamGitHubReadBinding,
      input: z.input<typeof teamGitHubRepositoryQuerySchema> = {},
    ) => repositories(workspaceId, actor, binding, input),
    async read(
      workspaceId: string,
      actor: HumanActor,
      inputBinding: TeamGitHubReadBinding,
      input: GitHubRead,
      sourceId?: string,
    ) {
      denyMcpEgress();
      const binding = teamGitHubReadBindingSchema.parse(inputBinding);
      const operation = githubReadSchema.parse(input);
      if (operation.kind === 'repository.search')
        return repositories(
          workspaceId,
          actor,
          binding,
          { query: operation.query, page: operation.page, perPage: operation.perPage },
          'github.investigation.read',
        );
      if (operation.kind.startsWith('project.')) throw new GitHubReadError('read-unqualified');
      const permissions = githubInvestigationPermissions(operation);
      const prepared = await authorized(
        workspaceId,
        actor,
        binding,
        'github.investigation.read',
        async (tx, integration) => {
          const sources = z
            .array(repositorySchema)
            .max(100)
            .parse(
              (
                await tx.client.query(
                  `SELECT id,owner,repo FROM ${table(tx, 'tf_integration_sources')} WHERE integration_id=$1`,
                  [binding.integrationId],
                )
              ).rows,
            );
          const source = sourceId
            ? sources.find(item => item.id === uuidSchema.parse(sourceId))
            : 'repo' in operation
              ? sources.find(item => sameRepository(item, operation.owner, operation.repo))
              : undefined;
          if (!source || ('repo' in operation && !sameRepository(source, operation.owner, operation.repo)))
            throw new AccessDenied();
          await requirePermissions(tx, actor, source.id, permissions);
          return { source, integration };
        },
      );
      const scoped = scopeTeamGitHubSearch(operation, prepared.source);
      const check = () =>
        authorized(workspaceId, actor, binding, 'github.investigation.read', async (tx, integration) => {
          if (integration.grants_version !== prepared.integration.grants_version) throw new AccessDenied();
          await requirePermissions(tx, actor, prepared.source.id, permissions);
        });
      const accessToken = cipher.decrypt(
        workspaceId,
        binding.integrationId,
        binding.generation,
        prepared.integration.credential,
      );
      let output;
      try {
        const fetcher: typeof fetch = async (url, init) => {
          await check();
          return (options.fetcher ?? fetch)(url, init);
        };
        if (scoped.kind === 'issue.comments') {
          const issue = await dispatchGitHubRead({
            operation: { kind: 'issue.read', owner: scoped.owner, repo: scoped.repo, number: scoped.number },
            credential: { accessToken },
            bindings: [],
            fetcher,
          });
          checkIssue(issue.data, scoped.number);
        }
        output = await dispatchGitHubRead({ operation: scoped, credential: { accessToken }, bindings: [], fetcher });
      } catch (error) {
        if (error instanceof GitHubCredentialRejected) throw new GitHubReadError('read-forbidden');
        throw error;
      }
      if (scoped.kind === 'issue.read') checkIssue(output.data, scoped.number);
      checkSearchResults(scoped, prepared.source, output.data);
      await check();
      const accessTargets =
        scoped.kind === 'discussion.search'
          ? z
              .object({ nodes: z.array(z.object({ number: z.number().int().positive() })) })
              .parse(output.data)
              .nodes.map(node =>
                githubReadSchema.parse({
                  kind: 'discussion.read',
                  owner: prepared.source.owner,
                  repo: prepared.source.repo,
                  number: node.number,
                }),
              )
          : searchAccessTargets(scoped, output.data);
      return {
        result: { provider: 'github-team', untrusted: true, operation: operation.kind, ...output },
        sources: [
          evidence(binding, prepared.integration, prepared.source, permissions, {
            operation: scoped,
            ...(accessTargets === undefined ? {} : { accessTargets }),
          }),
        ],
      };
    },
  };
}
