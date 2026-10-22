import { z } from 'zod';
import { denyMcpEgress, requireNoMcpDerived } from '@tulipfarm/access';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  requirePersonalGitHubSelection,
  requirePersonalGitHubSource,
  sourceDependenciesSchema,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { githubSourceDigest } from './source-runtime.ts';
import { searchAccessTargets } from './source-access.ts';
import { discussionSourceIdentity } from './discussion-source.ts';
import { projectSourceIdentity, projectListIdentity } from './project-source.ts';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { AccountRuntime, createGitHubAccounts } from './accounts.ts';
import {
  githubReadSchema,
  githubDownloadSchema,
  GitHubReadError,
  selectAccountSchema,
  selectionSchema,
} from './read-contracts.ts';
import { fetchGitHubDownload } from './download-provider.ts';
import { dispatchGitHubRead, type GitHubReadBinding } from './read-provider.ts';
import { selectOnlyAccount } from './batch-store.ts';
import { requireGitHubTaskExecution } from '@tulipfarm/access';
import {
  contextId,
  contextColumn,
  selectionTable,
  requireGitHubOrigin,
  requireGitHubSources,
  type GitHubContext,
} from './origin.ts';
import { githubSelection, writeGitHubSelection } from './selection.ts';

const range = { ...commonCompatibility, minimum: 1 };
type ReadOrigin = { conversationId: string; turnId: string } | { taskId: string; generation: number };
const readContext = (origin: ReadOrigin): GitHubContext =>
  'taskId' in origin ? { taskId: origin.taskId } : origin.conversationId;
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
export function createGitHubReads(options: {
  runtime: AccountRuntime;
  accounts: ReturnType<typeof createGitHubAccounts>;
  bindings?: readonly GitHubReadBinding[];
  fetcher?: typeof fetch;
}) {
  async function authorized<T>(
    workspaceId: string,
    principal: string | HumanActor,
    conversationId: GitHubContext,
    action: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    return options.runtime.transaction(z.uuid().parse(workspaceId), range, async tx => {
      await lockAuthorization(tx);
      const actor = typeof principal === 'string' ? await resolveHuman(tx, principal) : principal;
      await currentMember(tx, actor);
      await requireGitHubOrigin(tx, actor, conversationId);
      return action(tx, actor);
    });
  }
  async function selection(tx: AuthorizationTransaction, context: GitHubContext) {
    return selectionSchema.parse(
      (
        await tx.client.query(
          `SELECT account_id AS "accountId",account_generation AS generation,version FROM ${table(tx, selectionTable(context))} WHERE ${contextColumn(context)}=$1`,
          [contextId(context)],
        )
      ).rows[0] ?? { accountId: null, generation: null, version: 0 },
    );
  }
  async function sourceFor(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    origin: ReadOrigin,
    tool: string,
  ): Promise<Extract<SourceDependency, { kind: 'github-personal' }>> {
    if (!tool.startsWith('github.investigation.') && (await githubSelection(tx, readContext(origin))).investigation)
      throw new GitHubReadError('read-forbidden');
    if ('taskId' in origin) {
      await requireGitHubTaskExecution(tx, actor, origin.taskId, origin.generation, tool);
      await requireGitHubSources(tx, [{ kind: 'private-task', taskId: origin.taskId }]);
    } else {
      await requireNoMcpDerived(tx, [{ kind: 'private-conversation', conversationId: origin.conversationId }]);
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$1 AND conversation_id=$2 AND status='processing'`,
            [origin.turnId, origin.conversationId],
          )
        ).rowCount
      )
        throw new AccessDenied();
      if (tool !== 'github.investigation.read' && tool !== 'github.investigation.repositories')
        await selectOnlyAccount(tx, actor, origin.conversationId);
    }
    const selected = await selection(tx, readContext(origin));
    if (!selected.accountId || !selected.generation) throw new GitHubReadError('selection-required');
    const source = {
      kind: 'github-personal' as const,
      accountId: selected.accountId,
      generation: selected.generation,
      membershipId: actor.membershipId,
      selectionVersion: selected.version,
      ...('taskId' in origin
        ? { origin: 'task' as const, taskId: origin.taskId, taskGeneration: origin.generation }
        : { conversationId: origin.conversationId }),
    };
    await requirePersonalGitHubSelection(tx, actor, source);
    return source;
  }
  async function requireExecution(
    tx: AuthorizationTransaction,
    actor: HumanActor,
    origin: ReadOrigin,
    source: Extract<SourceDependency, { kind: 'github-personal' }>,
    tool: string,
  ) {
    await requireGitHubOrigin(tx, actor, readContext(origin));
    if ('taskId' in origin) await requireGitHubTaskExecution(tx, actor, origin.taskId, origin.generation, tool);
    else if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_conversation_turns')} WHERE id=$1 AND conversation_id=$2 AND status='processing'`,
          [origin.turnId, origin.conversationId],
        )
      ).rowCount
    )
      throw new AccessDenied();
    await requirePersonalGitHubSelection(tx, actor, source);
  }
  function executionFetch(
    workspaceId: string,
    actor: HumanActor,
    origin: ReadOrigin,
    source: Extract<SourceDependency, { kind: 'github-personal' }>,
    tool: string,
  ): typeof fetch {
    return async (url, init) => {
      await authorized(workspaceId, actor, readContext(origin), tx =>
        requireExecution(tx, actor, origin, source, tool),
      );
      return (options.fetcher ?? fetch)(url, init);
    };
  }
  return {
    async prepareDownload(workspaceId: string, actor: HumanActor, origin: ReadOrigin, callId: string, input: unknown) {
      denyMcpEgress();
      const operation = githubDownloadSchema.parse(input);
      const context = readContext(origin);
      const source = await authorized(workspaceId, actor, context, async tx => {
        if ('taskId' in origin) return sourceFor(tx, actor, origin, 'github.personal.download');
        if (
          !(
            await tx.client.query(
              `SELECT 1 FROM ${table(tx, 'tf_conversation_tool_calls')} c JOIN ${table(tx, 'tf_conversation_turns')} t ON t.id=c.turn_id WHERE c.id=$1 AND c.turn_id=$2 AND c.conversation_id=$3 AND c.tool='github.personal.download' AND c.status='running' AND t.status='processing'`,
              [z.uuid().parse(callId), z.uuid().parse(origin.turnId), origin.conversationId],
            )
          ).rowCount
        )
          throw new AccessDenied();
        return sourceFor(tx, actor, origin, 'github.personal.download');
      });
      const output = await options.accounts.withReadCredential(
        workspaceId,
        actor,
        source.accountId,
        credential =>
          fetchGitHubDownload({
            operation,
            credential,
            fetcher: executionFetch(workspaceId, actor, origin, source, 'github.personal.download'),
          }),
        source.generation,
        (tx, owner) => requireExecution(tx, owner, origin, source, 'github.personal.download'),
      );
      source.proof = {
        operation: output.metadataOperation,
        transport: 'rest',
        digest: githubSourceDigest(output.metadata),
        download: { id: callId, operation, filename: output.filename, size: output.size, sha256: output.sha256 },
      };
      await authorized(workspaceId, actor, context, tx => requirePersonalGitHubSelection(tx, actor, source));
      return {
        result: {
          provider: 'github-personal',
          untrusted: true,
          accountId: source.accountId,
          ...source.proof.download,
          downloadPath: `/v1/workspaces/${workspaceId}/github/${typeof context === 'string' ? 'chats' : 'tasks'}/${contextId(context)}/downloads/${callId}`,
          instruction:
            'Offer this exact downloadPath as a Markdown download link. Bytes are not model context. The owner must remain authorized and the source must remain unchanged.',
        },
        sources: [source],
      };
    },
    async download(workspaceId: string, userId: string, conversationId: GitHubContext, id: string) {
      const source = await authorized(workspaceId, userId, conversationId, async (tx, actor) => {
        const row =
          typeof conversationId === 'string'
            ? (
                await tx.client.query(
                  `SELECT r.sources FROM ${table(tx, 'tf_conversation_results')} r JOIN ${table(tx, 'tf_conversation_turns')} t ON t.id=r.turn_id JOIN ${table(tx, 'tf_conversation_tool_calls')} c ON c.turn_id=t.id WHERE r.conversation_id=$1 AND c.id=$2 AND c.tool='github.personal.download' AND c.status='completed' AND t.status='completed'`,
                  [conversationId, z.uuid().parse(id)],
                )
              ).rows[0]
            : (
                await tx.client.query(
                  `SELECT c.result->'sources' AS sources FROM ${table(tx, 'tf_agent_tool_calls')} c JOIN ${table(tx, 'tf_agent_task_runs')} b ON b.run_id=c.run_id WHERE b.task_id=$1 AND c.id=$2 AND c.call->>'tool'='github.personal.download' AND c.status='completed'`,
                  [conversationId.taskId, z.uuid().parse(id)],
                )
              ).rows[0];
        const source = sourceDependenciesSchema
          .parse(row?.sources ?? [])
          .find(item => item.kind === 'github-personal' && item.proof?.download?.id === id);
        if (
          !source ||
          source.kind !== 'github-personal' ||
          (source.origin === 'task'
            ? typeof conversationId === 'string' || source.taskId !== conversationId.taskId
            : source.conversationId !== conversationId) ||
          !source.proof?.download
        )
          throw new AccessDenied();
        await requirePersonalGitHubSource(tx, actor, source);
        return source;
      });
      const receipt = source.proof?.download;
      if (!receipt) throw new AccessDenied();
      const output = await options.accounts.withReadCredential(
        workspaceId,
        userId,
        source.accountId,
        credential =>
          fetchGitHubDownload({ operation: receipt.operation, credential, fetcher: options.fetcher ?? fetch }),
        source.generation,
        (tx, actor) => requirePersonalGitHubSelection(tx, actor, source),
      );
      if (
        output.sha256 !== receipt.sha256 ||
        output.size !== receipt.size ||
        output.filename !== receipt.filename ||
        githubSourceDigest(output.metadata) !== source.proof?.digest
      )
        throw new AccessDenied();
      await authorized(workspaceId, userId, conversationId, (tx, actor) =>
        requirePersonalGitHubSource(tx, actor, source),
      );
      return { filename: receipt.filename, bytes: output.bytes };
    },
    selection(workspaceId: string, userId: string, conversationId: GitHubContext) {
      return authorized(workspaceId, userId, conversationId, tx => selection(tx, conversationId));
    },
    async current(workspaceId: string, actor: HumanActor, conversationId: string) {
      return authorized(workspaceId, actor, conversationId, async tx => {
        await selectOnlyAccount(tx, actor, conversationId);
        const selected = await selection(tx, conversationId);
        if (!selected.accountId || !selected.generation) return null;
        const row = z
          .object({ login: z.string() })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT identity->>'login' AS login FROM ${table(tx, 'tf_github_accounts')} WHERE id=$1 AND owner_membership_id=$2 AND generation=$3 AND state='active' AND identity IS NOT NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())`,
                [selected.accountId, actor.membershipId, selected.generation],
              )
            ).rows[0],
          );
        return row ? { login: row.login } : null;
      });
    },
    async select(workspaceId: string, userId: string, conversationId: GitHubContext, input: unknown) {
      const value = selectAccountSchema.parse(input);
      const account = value.accountId ? await options.accounts.status(workspaceId, userId, value.accountId) : null;
      if (account && account.state !== 'active') throw new GitHubReadError('selection-conflict');
      return authorized(workspaceId, userId, conversationId, async (tx, actor) => {
        await writeGitHubSelection(tx, actor, conversationId, {
          accountId: account?.id ?? null,
          generation: account?.generation ?? null,
          integrationId: null,
          integrationGeneration: null,
          investigation: false,
          expectedVersion: value.expectedVersion,
        });
        return selection(tx, conversationId);
      });
    },
    async read(
      workspaceId: string,
      actor: HumanActor,
      origin: ReadOrigin,
      input: unknown,
      tool:
        | 'github.personal.read'
        | 'github.investigation.read'
        | 'github.investigation.repositories' = 'github.personal.read',
    ) {
      denyMcpEgress();
      const operation = githubReadSchema.parse(input);
      const source = await authorized(workspaceId, actor, readContext(origin), async tx => {
        const selected = await githubSelection(tx, readContext(origin));
        if (tool.startsWith('github.investigation.') ? !selected.investigation : selected.investigation)
          throw new GitHubReadError('selection-required');
        return sourceFor(tx, actor, origin, tool);
      });
      const output = await options.accounts.withReadCredential(
        workspaceId,
        actor,
        source.accountId,
        credential =>
          dispatchGitHubRead({
            operation,
            credential,
            bindings: options.bindings ?? [],
            fetcher: executionFetch(workspaceId, actor, origin, source, tool),
          }),
        source.generation,
        (tx, owner) => requireExecution(tx, owner, origin, source, tool),
      );
      const accessTargets = output.transport === 'rest' ? searchAccessTargets(operation, output.data) : undefined;
      const discussionIdentity = discussionSourceIdentity(operation, output.data);
      const projectIdentity = projectSourceIdentity(operation, output.data);
      const projectList = projectListIdentity(operation, output.data);
      source.proof = {
        operation,
        transport: output.transport,
        digest: githubSourceDigest(output.data),
        ...(accessTargets ? { accessTargets } : {}),
        ...(discussionIdentity ? { discussionIdentity } : {}),
        ...(projectIdentity ? { projectIdentity } : {}),
        ...(projectList ? { projectList } : {}),
      };
      await authorized(workspaceId, actor, readContext(origin), tx =>
        requirePersonalGitHubSelection(tx, actor, source),
      );
      return {
        result: {
          provider: 'github-personal',
          untrusted: true,
          accountId: source.accountId,
          operation: operation.kind,
          ...output,
        },
        sources: [source],
      };
    },
  };
}
