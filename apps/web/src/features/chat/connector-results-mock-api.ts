import { googleProposalSchema } from '@tulipfarm/google-workspace/public-contracts';
import { batchViewSchema } from '@tulipfarm/github/batch-contracts';
import { slackActionViewSchema } from '@tulipfarm/slack/action-contracts';
import { createGoogleResultsMock, googleResultsMockId } from './google-results-mock-api';

export function createConnectorResultsMock(scenario: string) {
  const fallback = createGoogleResultsMock('slides-empty');
  const workspaceId = '99999999-9999-4999-8999-999999999999';
  const id = (index: number) => `31313131-3131-4131-8131-${String(index).padStart(12, '0')}`;
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const unknown = scenario === 'connector-results-unknown';
  const pending = scenario === 'connector-results-pending';
  const chat = {
    id: googleResultsMockId,
    title: 'Connected app results',
    titleRevision: 1,
    titleManual: true,
    archived: false,
    activityAt: createdAt,
    createdAt,
    projectId: null,
  };
  const proposals = (
    ['docs.documents.create', 'sheets.spreadsheets.create', 'slides.presentations.create'] as const
  ).map((kind, index) =>
    googleProposalSchema.parse({
      id: id(index + 1),
      operation: { kind, title: ['Launch brief', 'Launch budget', 'Launch presentation'][index] },
      digest: 'f'.repeat(64),
      expiresAt,
      integration: {
        integrationId: workspaceId,
        accountId: 'local-demo',
        generation: 1,
        scopes: [],
        requiredScopes: [],
      },
      decision: pending ? null : 'approve',
      receipt: pending
        ? null
        : unknown
          ? { status: 'outcome-unknown', result: null, error: 'provider-outcome-unknown' }
          : {
              status: 'succeeded',
              result: {
                untrusted: true,
                data: {
                  id: `local-demo-${index}`,
                  title: ['Launch brief', 'Launch budget', 'Launch presentation'][index],
                },
              },
              error: null,
            },
    }),
  );
  const slack = slackActionViewSchema.parse({
    provider: 'slack',
    id: id(4),
    runId: id(5),
    digest: 'f'.repeat(64),
    action: { tool: 'slack.message.send', destinationId: id(6), text: 'The launch brief is ready for review.' },
    channel: 'CLOCALDEMO',
    status: pending ? 'pending' : unknown ? 'unknown' : 'sent',
    approvalRequired: true,
    expiresAt,
    nextAttemptAt: createdAt,
    sender: 'user',
    sentMessageTs: pending || unknown ? null : '1234567890.123456',
  });
  const batch = batchViewSchema.parse({
    snapshot: {
      id: id(7),
      workspaceId,
      membershipId: workspaceId,
      commandId: id(8),
      accountId: id(9),
      generation: 1,
      selectionVersion: 1,
      origin: { kind: 'chat', conversationId: googleResultsMockId, turnId: id(10), generation: 0 },
      sources: [],
      actions: [
        {
          kind: 'issue.create',
          owner: 'demo',
          repo: 'launch',
          title: 'Review the launch brief',
          body: 'Local seeded issue. No GitHub request is made.',
        },
      ],
      configurationDigest: 'f'.repeat(64),
      expiresAt,
    },
    digest: 'f'.repeat(64),
    decision: pending ? null : 'approve',
    expired: false,
    actions: [
      {
        ordinal: 0,
        status: pending ? 'unattempted' : unknown ? 'unknown' : 'succeeded',
        result: pending || unknown ? null : { number: 12 },
        reconciliation: null,
      },
    ],
  });
  const tools = [
    ...proposals.map(proposal => ({
      id: proposal.id,
      tool: 'google.propose',
      status: 'completed',
      googleProposalId: proposal.id,
    })),
    { id: slack.id, tool: 'slack.message.send', status: 'completed' },
    ...(
      [
        ['jira', 'Search Jira issues', 'atlassian.read'],
        ['confluence', 'Read the launch page', 'atlassian.read'],
        ['trello', 'Search launch cards', 'atlassian.read'],
        ['gmail', 'Read launch messages', 'google.read'],
        [null, 'Run the connected tool', 'mcp.call'],
      ] as const
    ).map(([brand, label, tool], index) => ({
      id: id(index + 11),
      tool,
      status: 'completed',
      activityStatus: unknown ? 'unknown' : 'completed',
      presentation: { brand, label },
    })),
  ];
  return async (url: URL, method: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> => {
    const path = url.pathname;
    if (
      path.includes('/operations/proposals/') ||
      path.includes('/slack/actions/') ||
      path.includes('/github/chats/')
    ) {
      if (method !== 'GET') return Response.json({ error: 'demo-is-read-only' }, { status: 409 });
      const proposal = proposals.find(item => path.endsWith(`/operations/proposals/${item.id}`));
      if (proposal) return Response.json(proposal);
      if (path.endsWith(`/slack/actions/${slack.id}`)) return Response.json(slack);
      if (path.endsWith(`/github/chats/${googleResultsMockId}/batches`))
        return Response.json({
          batches:
            scenario === 'connector-results-withheld'
              ? [
                  {
                    id: batch.snapshot.id,
                    decision: batch.decision,
                    actions: batch.actions.map(({ ordinal, status }) => ({ ordinal, status })),
                  },
                ]
              : [batch],
        });
    }
    if (method === 'GET' && path.endsWith(`/conversations/${googleResultsMockId}/messages`))
      return Response.json({
        messages: [
          {
            id: id(10),
            sequence: 1,
            author: 'assistant',
            createdAt,
            parts: [{ kind: 'text', text: 'Recorded app results from local seeded data. No provider is contacted.' }],
            tools,
            turn: null,
          },
        ],
        nextBefore: null,
        hasGitHubProposals: true,
      });
    if (method === 'GET' && path.endsWith(`/conversations/${googleResultsMockId}`)) return Response.json(chat);
    if (method === 'GET' && path.endsWith('/conversations')) return Response.json({ chats: [chat], nextCursor: null });
    return fallback(url, method, input, init);
  };
}
