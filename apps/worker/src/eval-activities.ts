import { Context } from '@temporalio/activity';
import { modelEnvironment } from '@tulipfarm/agents/model-environment';
import { createChatTools } from '@tulipfarm/agents/tools';
import { catalogEligibility, createWorkspaceEvals } from '@tulipfarm/evals/workspace';
import type { createKnowledgeTools } from './knowledge-tools-composition.ts';

type ChatToolRuntime = Parameters<typeof createChatTools>[0];

/** Runs a queued agent eval run. Live calls get only read tools; everything else is simulated by the eval engine. */
export function createEvalActivities(
  runtime: ChatToolRuntime,
  knowledge: ReturnType<typeof createKnowledgeTools>,
  objects?: NonNullable<Parameters<typeof createChatTools>[1]>['objects'],
) {
  const environment = modelEnvironment();
  const evals = createWorkspaceEvals({ runtime, environment, eligible: catalogEligibility(environment) });
  const tools = createChatTools(runtime, { knowledge, knowledgeBudgetRuntime: runtime, objects });
  return {
    async runAgentEval(workspaceId: string, runId: string) {
      await evals.execute(workspaceId, runId, tools, Context.current().cancellationSignal);
    },
  };
}
