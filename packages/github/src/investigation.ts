import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  resolveHuman,
  requireGitHubTaskExecution,
  requireNoMcpDerived,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import {
  githubInvestigationPermissionSchema,
  githubInvestigationPermissions,
} from '@tulipfarm/access/github-investigation';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { IntegrationKeyring } from '@tulipfarm/integrations';
import { createGitHubReads } from './reads.ts';
import { createTeamGitHubReads } from './team-reads.ts';
import { GitHubReadError, githubReadSchema } from './read-contracts.ts';
import {
  investigationChoicesSchema,
  investigationRepositoriesSchema,
  selectInvestigationSchema,
} from './investigation-contracts.ts';
import { githubSelection, writeGitHubSelection } from './selection.ts';
import { selectionTable, requireGitHubOrigin, requireGitHubSources, type GitHubContext } from './origin.ts';
import type { TeamGitHubReadBinding } from './team-read-contracts.ts';

type Origin = { conversationId: string; turnId: string } | { taskId: string; generation: number };
const contextFor = (origin: Origin): GitHubContext =>
  'taskId' in origin ? { taskId: origin.taskId } : origin.conversationId;
export async function investigationActive(tx: AuthorizationTransaction, context: GitHubContext) {
  const table = (name: string) => qualified(tx.schema, name);
  const selected = await githubSelection(tx, context);
  if (selected.investigation) return true;
  const result =
    typeof context === 'string'
      ? await tx.client.query(
          `SELECT 1 FROM ${table('tf_conversation_tool_calls')} c JOIN ${table('tf_conversation_turns')} t ON t.id=c.turn_id WHERE c.conversation_id=$1 AND c.tool LIKE 'github.investigation.%' AND t.accepted_sequence>=COALESCE((SELECT context_start FROM ${table('tf_github_chat_selection')} WHERE conversation_id=$1),1) LIMIT 1`,
          [context],
        )
      : await tx.client.query(
          `SELECT 1 FROM ${table('tf_agent_tool_calls')} c JOIN ${table('tf_agent_task_runs')} r ON r.run_id=c.run_id WHERE r.task_id=$1 AND c.call->>'tool' LIKE 'github.investigation.%' AND r.generation>=COALESCE((SELECT task_generation FROM ${table('tf_github_task_selection')} WHERE task_id=$1),0) LIMIT 1`,
          [context.taskId],
        );
  return Boolean(result.rowCount);
}
export function createGitHubInvestigation(
  options: Parameters<typeof createGitHubReads>[0] & {
    keyring?: IntegrationKeyring;
    teamKeyring?: () => IntegrationKeyring;
  },
) {
  const personal = createGitHubReads(options);
  const team = () => {
    const keyring = options.keyring ?? options.teamKeyring?.();
    return createTeamGitHubReads({
      runtime: options.runtime,
      ...(keyring ? { keyring } : {}),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
  };
  async function authorized<T>(
    workspaceId: string,
    principal: string | HumanActor,
    context: GitHubContext,
    action: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    return options.runtime.transaction(
      z.uuid().parse(workspaceId),
      { ...commonCompatibility, minimum: 1 },
      async tx => {
        await lockAuthorization(tx);
        const actor = typeof principal === 'string' ? await resolveHuman(tx, principal) : principal;
        await currentMember(tx, actor);
        await requireGitHubOrigin(tx, actor, context);
        return action(tx, actor);
      },
    );
  }
  async function choices(tx: AuthorizationTransaction, actor: HumanActor, id?: string) {
    const table = (name: string) => qualified(tx.schema, name);
    const personalRows = (
      await tx.client.query(
        `SELECT id,generation,identity->>'login' AS name FROM ${table('tf_github_accounts')} WHERE owner_membership_id=$1 AND ($2::uuid IS NULL OR id=$2) AND state='active' AND credential IS NOT NULL AND identity IS NOT NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY id LIMIT 100`,
        [actor.membershipId, id ?? null],
      )
    ).rows;
    const result = personalRows.map(row => ({
      kind: 'personal' as const,
      ...z.object({ id: z.uuid(), generation: z.number(), name: z.string() }).parse(row),
    }));
    const integrations = (
      await tx.client.query(
        `
      WITH member_teams AS (
        SELECT team_id FROM ${table('tf_member_teams')} WHERE membership_id=$1
      ), integration_permissions AS (
        SELECT integration_id,permission FROM ${table('tf_integration_person_grants')} WHERE membership_id=$1
        UNION ALL
        SELECT g.integration_id,g.permission FROM ${table('tf_integration_grants')} g JOIN member_teams mt ON mt.team_id=g.team_id
      ), usable_integrations AS (
        SELECT integration_id FROM integration_permissions GROUP BY integration_id
        HAVING bool_or(permission='read') AND bool_or(permission='use')
      ), source_permissions AS (
        SELECT integration_id,source_id FROM ${table('tf_integration_source_person_grants')} WHERE membership_id=$1 AND permission=ANY($3::text[])
        UNION ALL
        SELECT g.integration_id,g.source_id FROM ${table('tf_integration_source_grants')} g JOIN member_teams mt ON mt.team_id=g.team_id WHERE g.permission=ANY($3::text[])
      )
      SELECT c.id,c.generation,c.name FROM ${table('tf_integrations')} c
      JOIN usable_integrations u ON u.integration_id=c.id
      WHERE c.enabled AND c.deleted_at IS NULL AND c.credential IS NOT NULL AND ($2::uuid IS NULL OR c.id=$2)
        AND EXISTS (SELECT 1 FROM source_permissions p JOIN ${table('tf_integration_sources')} s ON s.id=p.source_id AND s.integration_id=p.integration_id WHERE p.integration_id=c.id)
      ORDER BY c.id LIMIT 100`,
        [actor.membershipId, id ?? null, githubInvestigationPermissionSchema.options],
      )
    ).rows;
    const teams = integrations.map(row => ({
      kind: 'team' as const,
      ...z.object({ id: z.uuid(), generation: z.number(), name: z.string() }).parse(row),
    }));
    return [...result, ...teams];
  }
  async function state(tx: AuthorizationTransaction, actor: HumanActor, context: GitHubContext) {
    const selected = await githubSelection(tx, context);
    const eligible = await choices(tx, actor);
    const selectedId = selected.accountId ?? selected.integrationId;
    const selectedChoices =
      selectedId && !eligible.some(choice => choice.id === selectedId)
        ? await choices(tx, actor, selectedId)
        : eligible;
    return investigationChoicesSchema.parse({
      investigation: await investigationActive(tx, context),
      version: selected.version,
      choices: eligible,
      selected: selected.investigation
        ? (selectedChoices.find(choice =>
            choice.kind === 'personal'
              ? choice.id === selected.accountId && choice.generation === selected.generation
              : choice.id === selected.integrationId && choice.generation === selected.integrationGeneration,
          ) ?? null)
        : null,
    });
  }
  async function startUnselected(tx: AuthorizationTransaction, origin: Origin) {
    const context = contextFor(origin);
    const selected = await githubSelection(tx, context);
    if (selected.investigation || selected.accountId || selected.integrationId) return;
    const table = qualified(tx.schema, selectionTable(context));
    if (typeof context === 'string')
      await tx.client.query(
        `INSERT INTO ${table} (conversation_id,investigation,version,context_start) VALUES ($1,true,1,1) ON CONFLICT (conversation_id) DO UPDATE SET investigation=true,version=tf_github_chat_selection.version+1 WHERE tf_github_chat_selection.account_id IS NULL AND tf_github_chat_selection.integration_id IS NULL AND NOT tf_github_chat_selection.investigation`,
        [context],
      );
    else
      await tx.client.query(
        `INSERT INTO ${table} (task_id,investigation,task_generation,context_start,version) VALUES ($1,true,$2,0,1) ON CONFLICT (task_id) DO UPDATE SET investigation=true,version=tf_github_task_selection.version+1 WHERE tf_github_task_selection.account_id IS NULL AND tf_github_task_selection.integration_id IS NULL AND NOT tf_github_task_selection.investigation`,
        [context.taskId, 'taskId' in origin ? origin.generation : 0],
      );
  }
  async function binding(workspaceId: string, actor: HumanActor, origin: Origin, tool: string) {
    return authorized(workspaceId, actor, contextFor(origin), async tx => {
      if ('taskId' in origin) {
        await requireGitHubTaskExecution(tx, actor, origin.taskId, origin.generation, tool);
        await requireGitHubSources(tx, [{ kind: 'private-task', taskId: origin.taskId }]);
      } else {
        await requireNoMcpDerived(tx, [{ kind: 'private-conversation', conversationId: origin.conversationId }]);
        if (
          !(
            await tx.client.query(
              `SELECT 1 FROM ${qualified(tx.schema, 'tf_conversation_turns')} WHERE id=$1 AND conversation_id=$2 AND status='processing'`,
              [origin.turnId, origin.conversationId],
            )
          ).rowCount
        )
          throw new AccessDenied();
      }
      await startUnselected(tx, origin);
      const selection = await githubSelection(tx, contextFor(origin));
      if (!selection.investigation || (!selection.accountId && !selection.integrationId))
        return { missing: true as const };
      return {
        missing: false as const,
        team:
          selection.integrationId && selection.integrationGeneration
            ? ({
                integrationId: selection.integrationId,
                generation: selection.integrationGeneration,
                membershipId: actor.membershipId,
                selectionVersion: selection.version,
                origin:
                  'taskId' in origin
                    ? { kind: 'task' as const, taskId: origin.taskId, generation: origin.generation }
                    : { kind: 'chat' as const, conversationId: origin.conversationId, turnId: origin.turnId },
              } satisfies TeamGitHubReadBinding)
            : null,
      };
    });
  }
  return {
    choices(workspaceId: string, userId: string, context: GitHubContext) {
      return authorized(workspaceId, userId, context, (tx, actor) => state(tx, actor, context));
    },
    async select(workspaceId: string, userId: string, context: GitHubContext, input: unknown) {
      const value = selectInvestigationSchema.parse(input);
      return authorized(workspaceId, userId, context, async (tx, actor) => {
        const eligible = value.choice ? await choices(tx, actor, value.choice.id) : [];
        if (
          value.choice &&
          !eligible.some(
            choice =>
              choice.kind === value.choice?.kind &&
              choice.id === value.choice.id &&
              choice.generation === value.choice.generation,
          )
        )
          throw new AccessDenied();
        const personal = value.choice?.kind === 'personal' ? value.choice : null;
        const team = value.choice?.kind === 'team' ? value.choice : null;
        await writeGitHubSelection(tx, actor, context, {
          accountId: personal?.id ?? null,
          generation: personal?.generation ?? null,
          integrationId: team?.id ?? null,
          integrationGeneration: team?.generation ?? null,
          investigation: value.investigation,
          expectedVersion: value.expectedVersion,
        });
        return state(tx, actor, context);
      });
    },
    async account(workspaceId: string, actor: HumanActor, origin: Origin) {
      return authorized(workspaceId, actor, contextFor(origin), async tx => {
        if ('taskId' in origin)
          await requireGitHubTaskExecution(tx, actor, origin.taskId, origin.generation, 'github.investigation.account');
        else if (
          !(
            await tx.client.query(
              `SELECT 1 FROM ${qualified(tx.schema, 'tf_conversation_turns')} WHERE id=$1 AND conversation_id=$2 AND status='processing'`,
              [origin.turnId, origin.conversationId],
            )
          ).rowCount
        )
          throw new AccessDenied();
        await startUnselected(tx, origin);
        const current = await state(tx, actor, contextFor(origin));
        return {
          provider: 'github-investigation',
          selected: current.selected,
          instruction: current.selected
            ? 'Continue read-only investigation with this source only. Switching requires the human chooser and starts fresh context.'
            : 'Ask the human to choose a personal account or team integration in the investigation card, then stop. You cannot choose for them. Do not try other GitHub tools.',
        };
      });
    },
    async repositories(workspaceId: string, actor: HumanActor, origin: Origin, input: unknown) {
      const query = investigationRepositoriesSchema.parse(input);
      const selected = await binding(workspaceId, actor, origin, 'github.investigation.repositories');
      if (selected.missing) throw new GitHubReadError('selection-required');
      if (selected.team) return team().repositories(workspaceId, actor, selected.team, query);
      if (!query.query) throw new GitHubReadError('read-unqualified');
      return personal.read(
        workspaceId,
        actor,
        origin,
        { kind: 'repository.search', ...query },
        'github.investigation.repositories',
      );
    },
    async read(workspaceId: string, actor: HumanActor, origin: Origin, input: unknown, sourceId?: string) {
      const operation = githubReadSchema.parse(input);
      if (operation.kind.startsWith('project.')) throw new GitHubReadError('read-forbidden');
      githubInvestigationPermissions(operation);
      const selected = await binding(workspaceId, actor, origin, 'github.investigation.read');
      if (selected.missing) throw new GitHubReadError('selection-required');
      return selected.team
        ? team().read(workspaceId, actor, selected.team, operation, sourceId)
        : personal.read(workspaceId, actor, origin, operation, 'github.investigation.read');
    },
  };
}
