import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createAgentChat, type ModelContinuity } from '@tulipfarm/agents/chat';
import type { ModelFamilyEligibility } from '@tulipfarm/agents/model-policy';
import { createAgentSetup, type AgentSetupOptions } from '@tulipfarm/agents/setup';
import { slackActionsFromEnvironment } from '@tulipfarm/agents/slack-environment';
import { createIntegrationService, integrationCredentialKeyring } from '@tulipfarm/integrations';
import type { WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { backgroundSweep, readyWorkspaces } from './background-sweep.ts';
import { googleOperations } from './google-composition.ts';

export type AgentWork = ReturnType<typeof createAgentWork>;

export function createAgentWork(dependencies: {
  runtime: WorkspaceRuntime;
  agentModel?: ModelContinuity | null | undefined;
  modelFamilyEligibility?: ModelFamilyEligibility | undefined;
  agentSetup?: AgentSetupOptions | undefined;
}) {
  const setup = createAgentSetup(dependencies.runtime, dependencies.modelFamilyEligibility, dependencies.agentSetup);
  const chat = createAgentChat(
    dependencies.runtime,
    dependencies.agentModel ?? null,
    {
      readIssue: (workspaceId, actor, input) =>
        createIntegrationService({ runtime: dependencies.runtime, keyring: integrationCredentialKeyring() }).readIssue(
          workspaceId,
          actor,
          input,
        ),
    },
    googleOperations,
    undefined,
    slackActionsFromEnvironment(),
  );
  return { setup, chat };
}

/** Advances pending agent chat turns and setup commands. */
export function registerAgentSweeps(app: FastifyInstance, pool: Pool, { setup, chat }: AgentWork) {
  let after: string | null = null;
  async function sweepChat(stopped: () => boolean) {
    const rows = await readyWorkspaces(pool, after, 20);
    await Promise.all(
      rows.map(async row => {
        if (stopped()) return;
        try {
          const [id] = await chat.pending(row.workspace_id);
          if (id && !stopped()) await chat.processTurn(row.workspace_id, id);
        } catch {
          app.log.error({ workspaceId: row.workspace_id }, 'Agent chat will retry');
        }
      }),
    );
    after = rows.length < 20 ? null : (rows.at(-1)?.workspace_id ?? null);
  }
  backgroundSweep(app, sweepChat, 'Agent chat discovery will retry', 'agent-chat-discovery', { immediate: false });
  let setupAfter: string | null = null;
  backgroundSweep(
    app,
    async stopped => {
      const rows = await readyWorkspaces(pool, setupAfter, 20);
      for (const row of rows) {
        if (stopped()) return;
        try {
          for (const command of await setup.pending(row.workspace_id)) {
            if (stopped()) return;
            await setup.advance(row.workspace_id, command.user_id, command.id);
          }
        } catch {
          app.log.error({ workspaceId: row.workspace_id }, 'Agent setup will retry');
        }
      }
      setupAfter = rows.length < 20 ? null : (rows.at(-1)?.workspace_id ?? null);
    },
    'Agent setup discovery will retry',
    'agent-setup-discovery',
  );
}
