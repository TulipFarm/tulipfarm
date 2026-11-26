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

const samplePrompt =
  'Which message should the workflow post in #github-notify after the review is done? The samples use example values. The real message uses the data of each pull request.';
const sampleChoices = [
  {
    id: 'short',
    label:
      '✅ Review done for PR #142 "Add retry to webhook sender" in TulipFarm/tulipfarm by @asha. [Open PR](https://github.com/TulipFarm/tulipfarm/pull/142)',
  },
  {
    id: 'detailed',
    label:
      '🤖 **PR Code Reviewer** finished a review **Repo:** TulipFarm/tulipfarm **PR:** [#142 Add retry to webhook sender](https://github.com/TulipFarm/tulipfarm/pull/142) **Author:** @asha **Result:** 3 comments, 1 blocking',
  },
  {
    id: 'minimal',
    label:
      'Code review finished: TulipFarm/tulipfarm #142 – Add retry to webhook sender (https://github.com/TulipFarm/tulipfarm/pull/142)',
  },
];
// Local scenarios for long and many options; each starts pending unless its name says answered or cancelled.
const choiceScenarios: Record<string, { prompt?: string; choices: { id: string; label: string }[] }> = {
  'workflow-sample-choices': { prompt: samplePrompt, choices: sampleChoices },
  'workflow-many-choices': {
    choices: [
      '#general',
      '#tech',
      '#github-notify',
      '#releases',
      '#design',
      '#support',
      '#sales',
      '#random',
      '#ops',
      '#alerts',
    ].map(name => ({ id: name.slice(1), label: name })),
  },
  'workflow-url-choice': {
    choices: [
      {
        id: 'url',
        label:
          'https://github.com/TulipFarm/tulipfarm/pull/142/files?diff=split&w=1&file-filters%5B%5D=.ts&show-viewed-files=true',
      },
      {
        id: 'mixed',
        label:
          'Post one short line, then link the review: https://github.com/TulipFarm/tulipfarm/pull/142#pullrequestreview-2468013579',
      },
      { id: 'none', label: 'No link' },
    ],
  },
  'workflow-sample-prompt': {
    prompt: `Which message should the workflow post in #github-notify?\n\n**Short:** ✅ Review done for [#142 Add retry to webhook sender](https://github.com/TulipFarm/tulipfarm/pull/142) by @asha.\n\n**Detailed:** 🤖 **PR Code Reviewer** finished a review of [#142](https://github.com/TulipFarm/tulipfarm/pull/142). 3 comments, 1 blocking.\n\n**Minimal:** Code review finished: TulipFarm/tulipfarm #142.`,
    choices: [
      { id: 'short', label: 'Short (Recommended)' },
      { id: 'detailed', label: 'Detailed' },
      { id: 'minimal', label: 'Minimal' },
    ],
  },
  'workflow-answered-long': { prompt: samplePrompt, choices: sampleChoices },
  'workflow-answered-short': { choices: [] },
  'workflow-answered-text': { prompt: samplePrompt, choices: sampleChoices },
  'workflow-cancelled': { prompt: samplePrompt, choices: sampleChoices },
};

export function createWorkflowChatMock(scenario: string) {
  const preset = choiceScenarios[scenario];
  const choices = preset?.choices.length
    ? preset.choices
    : [
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
      triggers: [{ id: 'webhook', kind: 'webhook' }],
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
    prompt: preset?.prompt ?? 'Who should send the Slack notification?',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    answerSchema: { kind: 'choices', multiple: false, allowText: true, choices },
    status: scenario.startsWith('workflow-answered')
      ? 'answered'
      : scenario === 'workflow-cancelled'
        ? 'cancelled'
        : 'pending',
    response: scenario.startsWith('workflow-answered')
      ? {
          id: '20202020-2020-4020-8020-202020202020',
          answer:
            scenario === 'workflow-answered-text'
              ? {
                  kind: 'text',
                  text: 'Post a short line with the PR title and link, then put the full review summary in a thread reply so the channel stays quiet. Mention the author only when there is a blocking comment.',
                }
              : { kind: 'choices', choiceIds: [choices[0]!.id] },
          createdAt,
        }
      : null,
  };
  let definitionReads = 0;
  const actionReads = new Map<string, number>();
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
      const origin = url.searchParams.get('originId') ?? '';
      const reads = (actionReads.get(origin) ?? 0) + 1;
      actionReads.set(origin, reads);
      // A read retries a 503 once and the query retries twice; eight failures also cover a remount's extra read.
      if (scenario === 'workflow-errors' && reads <= 8)
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
      if (scenario === 'workflow-errors' && definitionReads <= 8)
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
