import { z } from 'zod';
import type { executionPolicySchema } from '@tulipfarm/agents/contracts';
import {
  agentCommandStatusSchema,
  agentPolicySchema,
  agentContextSchema,
  agentDataScopeReceiptSchema,
  type agentDataScopeSchema,
  agentDetailSchema,
  agentPolicyDetailSchema,
  agentListSchema,
  type saveAgentSchema,
} from '@tulipfarm/agents/saved-contracts';
import { apiOrigin } from '@/lib/auth';
import { teamLabel } from '@/features/governance/team-labels';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';
import {
  chatInputSchema,
  chatReceiptSchema,
  chatStatusSchema,
  retryModelSchema,
  retryModelReceiptSchema,
} from '@tulipfarm/agents/chat-contracts';
import { slackActionViewSchema, slackDecisionSchema } from '@tulipfarm/slack/action-contracts';
import { webAgentDefinitionSchema } from './definition';
import { definitionSharingCandidatesSchema } from '@tulipfarm/agents/saved-contracts';
import {
  agentLinkedWorkflowSchema,
  agentSetupDraftSchema,
  agentSetupReceiptSchema,
  type SaveAgentSetupDraft,
  type PublishAgentSetup,
} from '@tulipfarm/agents/setup-contracts';

const webAgentDetailSchema = agentDetailSchema.extend({ definition: webAgentDefinitionSchema });
export type AgentDetail = z.infer<typeof webAgentDetailSchema>;
export type AgentContext = z.infer<typeof agentContextSchema>;
export type AgentInput = Omit<z.infer<typeof saveAgentSchema>, 'definition'> & {
  definition: z.infer<typeof webAgentDefinitionSchema>;
};
export type AgentCommand = z.infer<typeof agentCommandStatusSchema>;
type ExecutionSettings = z.infer<typeof executionPolicySchema>;

const rejections: Partial<Record<string, string>> = {
  'agent-team-assignment-required':
    'You need a manager of the selected team to give this agent access. Ask a team manager to enroll it. Your input is retained.',
  'agent-table-access-unavailable':
    'A selected table is not available through your selected teams. In What data it can use, choose a team you belong to that grants the selected table access. Your input is retained.',
  'trigger-sponsor-consent-required':
    'Sponsor the triggers that run on their own before activating. Your input is retained.',
  'setup-draft-outdated': 'This setup was saved before triggers were combined. Save it again before activating.',
  'task-schedule-interval': `Scheduled triggers run this agent at most once an hour. Choose an hourly-or-longer interval or calendar expression. Your input is retained.`,
  'schedule-invalid':
    'This calendar schedule is invalid. Check the cron expression and IANA time zone. Your input is retained.',
};

export function agentApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/agents`;
  async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      cache: 'no-store',
      signal: signal ?? AbortSignal.timeout(15000),
      body,
    });
    const value = await readJson(response);
    if (!response.ok) {
      const code = responseError(value, 'agent-operation-failed');
      if (code === 'credits-exhausted')
        throw new TableRequestError(
          response.status,
          code,
          'Your workspace has no available credits. Ask a workspace admin to check credits. Your input is retained.',
        );
      const message =
        rejections[code] ??
        (code === 'model-family-unavailable'
          ? 'Your model preference is retained. Its route is unavailable. Choose an eligible model family, or try saving again when the route is restored.'
          : response.status === 404
            ? 'This agent is missing or you no longer have access.'
            : response.status === 409
              ? 'An agent, policy, or workspace definition changed. Refresh status and review your retained edits before saving again.'
              : 'The agent operation could not be completed. Your input is retained.');
      throw new TableRequestError(response.status, code, message);
    }
    return value;
  }
  return {
    sharingCandidates: async (signal: AbortSignal) =>
      definitionSharingCandidatesSchema.parse(await request('/sharing-candidates', 'GET', undefined, signal)),
    slackTaskActions: async (taskId: string, signal: AbortSignal) => {
      const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${workspaceId}/slack/tasks/${taskId}/actions`, {
        method: 'GET',
        cache: 'no-store',
        signal,
      });
      if (!response.ok)
        throw new TableRequestError(
          response.status,
          'slack-action-unavailable',
          'Slack actions could not be loaded. Check current access and try again.',
        );
      return z.object({ actions: z.array(slackActionViewSchema) }).parse(await readJson(response));
    },
    slackAction: async (id: string, signal: AbortSignal) => {
      const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${workspaceId}/slack/actions/${id}`, {
        method: 'GET',
        cache: 'no-store',
        signal,
      });
      if (!response.ok)
        throw new TableRequestError(
          response.status,
          'slack-action-unavailable',
          'The Slack action could not be loaded. Check your access and try again.',
        );
      return slackActionViewSchema.parse(await readJson(response));
    },
    slackDecision: async (id: string, input: z.infer<typeof slackDecisionSchema>) => {
      const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${workspaceId}/slack/actions/${id}`, {
        method: 'PUT',
        cache: 'no-store',
        signal: AbortSignal.timeout(20000),
        body: input,
      });
      if (!response.ok)
        throw new TableRequestError(
          response.status,
          'slack-decision-unavailable',
          'The decision could not be confirmed. Check current action status before continuing.',
        );
      return slackActionViewSchema.parse(await readJson(response));
    },
    list: async (signal: AbortSignal, after?: string, search = '', archived = false) =>
      agentListSchema.parse(
        await request(
          `?${new URLSearchParams({ ...(after ? { after } : {}), ...(search ? { search } : {}), ...(archived ? { archived: 'true' } : {}) })}`,
          'GET',
          undefined,
          signal,
        ),
      ),
    context: async (signal: AbortSignal) => {
      const context = agentContextSchema.parse(await request('/authoring-context', 'GET', undefined, signal));
      return { ...context, teams: context.teams.map(team => ({ ...team, name: teamLabel(team.name) })) };
    },
    setupDraft: async (id: string, signal: AbortSignal) =>
      agentSetupDraftSchema.parse(await request(`/${id}/setup-draft`, 'GET', undefined, signal)),
    saveSetupDraft: async (id: string, input: SaveAgentSetupDraft) =>
      agentSetupDraftSchema.parse(await request(`/${id}/setup-draft`, 'PUT', input)),
    publishSetup: async (id: string, input: PublishAgentSetup) =>
      agentSetupReceiptSchema.parse(await request(`/${id}/setup`, 'POST', input)),
    linkedWorkflow: async (id: string, signal: AbortSignal) =>
      agentLinkedWorkflowSchema.parse(await request(`/${id}/linked-workflow`, 'GET', undefined, signal)),
    setupCommand: async (id: string, signal: AbortSignal) =>
      agentSetupReceiptSchema.parse(await request(`/setup-commands/${id}`, 'GET', undefined, signal)),
    retrySetupCommand: async (id: string) =>
      agentSetupReceiptSchema.parse(await request(`/setup-commands/${id}/retry`, 'POST', {})),
    detail: async (id: string, signal: AbortSignal) =>
      webAgentDetailSchema.parse(await request(`/${id}`, 'GET', undefined, signal)),
    save: async (id: string, input: AgentInput) =>
      agentCommandStatusSchema.parse(await request(`/${id}`, 'PUT', input)),
    command: async (id: string, signal: AbortSignal) =>
      agentCommandStatusSchema.parse(await request(`/commands/${id}`, 'GET', undefined, signal)),
    policy: async (id: string, signal: AbortSignal) =>
      agentPolicyDetailSchema.parse(await request(`/${id}/policy`, 'GET', undefined, signal)),
    updatePolicy: async (id: string, input: z.infer<typeof agentPolicySchema>) =>
      request(`/${id}/policy`, 'PUT', input),
    remove: async (id: string) => request(`/${id}`, 'DELETE'),
    archive: async (id: string) => request(`/${id}/archive`, 'POST', {}),
    restore: async (id: string) => request(`/${id}/restore`, 'POST', {}),
    configure: async (id: string, input: ExecutionSettings) => request(`/${id}/enrollment`, 'PUT', input),
    updateDataScope: async (id: string, input: z.infer<typeof agentDataScopeSchema>) =>
      agentDataScopeReceiptSchema.parse(await request(`/${id}/data-scope`, 'PUT', input)),
    revokeActivation: async (id: string, activationId: string) =>
      z.object({ saved: z.literal(true) }).parse(await request(`/${id}/activations/${activationId}`, 'DELETE')),
    activate: async (
      id: string,
      input: { requestId: string; revision: string; scope: AgentDetail['activations'][number]['scope'] },
    ) => z.object({ activationId: z.uuid() }).parse(await request(`/${id}/activations`, 'POST', input)),
    chatAvailability: async (id: string, signal: AbortSignal) =>
      z.object({ configured: z.boolean() }).parse(await request(`/${id}/chat`, 'GET', undefined, signal)),
    chat: async (id: string, input: z.infer<typeof chatInputSchema>) =>
      chatReceiptSchema.parse(await request(`/${id}/chat`, 'PUT', input)),
    turn: async (id: string, turnId: string, signal: AbortSignal) =>
      chatStatusSchema.parse(await request(`/${id}/chat/${turnId}`, 'GET', undefined, signal)),
    retryModel: async (id: string, turnId: string, input: z.infer<typeof retryModelSchema>) =>
      retryModelReceiptSchema.parse(await request(`/${id}/chat/${turnId}/retry`, 'POST', input)),
  };
}
