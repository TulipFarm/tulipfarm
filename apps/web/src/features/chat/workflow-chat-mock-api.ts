import { z } from 'zod';
import { definitionViewSchema } from '@tulipfarm/workflows/contracts';
import { answerSchema, type InformationRequest } from './interaction-contracts';

export const workflowChatMockId = '12121212-1212-4212-8212-121212121212';
const requestId = '13131313-1313-4313-8313-131313131313';
const workflowId = '14141414-1414-4414-8414-141414141414';
const revision = '15151515-1515-4515-8515-151515151515';
const turnId = '16161616-1616-4616-8616-161616161616';
const destinationId = '17171717-1717-4717-8717-171717171717';
const workspaceId = '99999999-9999-4999-8999-999999999999';
const commandSchema = z.object({
  commandId: z.uuid(),
  expectedRevision: z.number().int(),
  answer: answerSchema.optional(),
});

export function createWorkflowChatMock(scenario: string) {
  const choices = [
    { id: 'app', label: 'TulipFarm app (Recommended)' },
    { id: 'personal', label: 'My personal Slack account' },
    ...(['workflow-three-choices', 'workflow-four-choices', 'workflow-long-choices'].includes(scenario)
      ? [{ id: 'release', label: 'Release bot' }]
      : []),
    ...(['workflow-four-choices', 'workflow-long-choices'].includes(scenario)
      ? [
          {
            id: 'team',
            label:
              scenario === 'workflow-long-choices'
                ? 'A dedicated team account used only for engineering release notifications'
                : 'Team account',
          },
        ]
      : []),
  ];
  const createdAt = new Date().toISOString();
  const chat = {
    id: workflowChatMockId,
    title: 'Send GitHub pull request summaries to Slack',
    titleRevision: 1,
    titleManual: true,
    archived: false,
    activityAt: createdAt,
    createdAt,
    projectId: null,
  };
  const detail = definitionViewSchema.parse({
    workflowId,
    revision,
    savedRevision: revision,
    activeRevision: revision,
    canManage: true,
    archived: false,
    actor: { id: workspaceId, userId: 'bud-mock', name: 'Dhruv Jain' },
    definition: {
      version: 1,
      name: 'TulipFarm pull request summaries to tech',
      trigger: { kind: 'webhook' },
      steps: [
        {
          id: 'notify',
          kind: 'slack-message',
          destinationId,
          sender: 'app',
          text: { kind: 'literal', value: 'A pull request is ready for review. Open GitHub to read the changes.' },
        },
      ],
    },
  });
  const question: InformationRequest = {
    id: requestId,
    turnId,
    revision: 1,
    prompt: 'Who should send the Slack notification?',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    answerSchema: { kind: 'choices', multiple: false, allowText: true, choices },
    status: 'pending',
    response: null,
  };
  let definitionReads = 0;
  let actionReads = 0;
  const commands = new Map<string, unknown>();
  return async (url: URL, method: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> => {
    const path = url.pathname;
    if (method === 'GET' && path.endsWith('/workspace-mcp/capabilities'))
      return Response.json({
        enabled: true,
        canManageShared: false,
        integrationsEnabled: false,
        dispatchEnabled: false,
      });
    if (method === 'GET' && path.endsWith('/workspace-mcp/actions')) {
      actionReads++;
      if (scenario === 'workflow-errors' && actionReads <= 3)
        return Response.json({ error: 'demo-actions-unavailable' }, { status: 503 });
      return Response.json({ actions: [], nextCursor: null });
    }
    if (method === 'GET' && path.endsWith(`/slack/destinations/${destinationId}`))
      return Response.json({
        id: destinationId,
        name: 'tech',
        channel: 'CDEMO',
        teamId: 'TDEMO',
        installationId: workspaceId,
      });
    if (method === 'GET' && path.endsWith(`/workflows/${workflowId}`)) {
      definitionReads++;
      if (scenario === 'workflow-loading') await new Promise(resolve => setTimeout(resolve, 2000));
      if (scenario === 'workflow-errors' && definitionReads <= 3)
        return Response.json({ error: 'demo-workflow-unavailable' }, { status: 503 });
      if (scenario === 'workflow-unavailable') return Response.json({ error: 'not-found' }, { status: 404 });
      return Response.json(detail);
    }
    if (method === 'GET' && path.endsWith('/conversations')) return Response.json({ chats: [chat], nextCursor: null });
    if (!path.includes(`/conversations/${workflowChatMockId}`)) return null;
    if (path.includes(`/requests/${requestId}`)) {
      if (method === 'GET') return Response.json(question);
      if (!(method === 'PUT' && /\/responses\/[^/]+$/.test(path)) && !(method === 'POST' && path.endsWith('/cancel')))
        return Response.json({ error: 'unsupported-demo-command' }, { status: 405 });
      const body: unknown =
        typeof init?.body === 'string' ? JSON.parse(init.body) : input instanceof Request ? await input.json() : null;
      const parsed = commandSchema.safeParse(body);
      if (!parsed.success) return Response.json({ error: 'invalid-request' }, { status: 400 });
      if (commands.has(parsed.data.commandId)) return Response.json(commands.get(parsed.data.commandId));
      if (question.status !== 'pending' || parsed.data.expectedRevision !== question.revision)
        return Response.json({ error: 'request-conflict' }, { status: 409 });
      const answer = parsed.data.answer;
      if (
        method === 'PUT' &&
        (!answer ||
          (answer.kind === 'text'
            ? !answer.text.trim()
            : !answer.choiceIds.length || answer.choiceIds.some(id => !choices.some(choice => choice.id === id))))
      )
        return Response.json({ error: 'invalid-answer' }, { status: 400 });
      question.status = method === 'PUT' ? 'answered' : 'cancelled';
      question.response = answer ? { id: path.split('/').at(-1)!, answer, createdAt: new Date().toISOString() } : null;
      const outcome = {
        requestId,
        revision: question.revision,
        status: question.status,
        responseId: question.response?.id ?? null,
      };
      commands.set(parsed.data.commandId, outcome);
      await new Promise(resolve => setTimeout(resolve, 300));
      return Response.json(outcome);
    }
    if (method !== 'GET') return Response.json({ error: 'demo-has-no-live-model-or-provider-writes' }, { status: 409 });
    if (path.endsWith('/plans')) return Response.json([]);
    if (path.endsWith('/messages'))
      return Response.json({
        messages:
          scenario === 'workflow-empty'
            ? []
            : [
                {
                  id: turnId,
                  sequence: 1,
                  author: 'human',
                  createdAt,
                  parts: [{ kind: 'text', text: 'Send pull request summaries from TulipFarm to #tech in Slack.' }],
                  turn: { id: turnId, status: question.status === 'pending' ? 'waiting' : 'completed', generation: 0 },
                  tools: ['workflows.list', 'workflows.read'].map((tool, index) => ({
                    id: `18181818-1818-4818-8818-${String(index + 1).padStart(12, '0')}`,
                    tool,
                    status: 'completed',
                    workflows: [{ workflowId, revision, name: detail.definition.name }],
                  })),
                },
                {
                  id: '19191919-1919-4919-8919-191919191919',
                  sequence: 2,
                  author: 'assistant',
                  createdAt,
                  parts: [
                    {
                      kind: 'text',
                      text: '**The workflow is saved. Delivery is not set up yet.**\n\nChoose the sender below. Then configure the incoming GitHub webhook. Each Slack message still needs your approval before it is sent.\n\n*Local demo: seeded data only. No GitHub or Slack actions run.*',
                    },
                    { kind: 'request', requestId },
                  ],
                  turn: null,
                  tools: [],
                },
              ],
        nextBefore: null,
        hasGitHubProposals: false,
      });
    if (path.endsWith(`/conversations/${workflowChatMockId}`)) return Response.json(chat);
    return null;
  };
}
