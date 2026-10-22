import { knowledgeActivity } from '@tulipfarm/conversations/knowledge-activity';

export const knowledgeScenarios = {
  knowledge: 'Knowledge: grouped search',
  'knowledge-partial': 'Knowledge: partial deep round',
  'knowledge-empty': 'Knowledge: no matches',
  'knowledge-unavailable': 'Knowledge: source unavailable',
  'knowledge-failed': 'Knowledge: failed read',
  'knowledge-exhausted': 'Knowledge: limit reached',
  'knowledge-cancelled': 'Knowledge: cancelled',
};
const id = '11111111-1111-4111-8111-111111111111';
const tool = 'knowledge.retrieve';

export function knowledgeMockMessages(scenario: string, completed: boolean, createdAt: string) {
  const running = scenario === 'knowledge' && !completed;
  const partial = scenario === 'knowledge-partial';
  const action = partial ? 'expand' : 'search';
  const documents = ['Pitch: product', 'Pitch: customers', 'Pitch: results', 'Pitch: pricing'].map(title => ({
    title,
    completeness: partial ? 'partial' : 'complete',
    omitted: partial,
    passages: Array.from({ length: 3 }, () => ({ truncated: false })),
  }));
  const branch = (index: number, status: string, reason: string | null, evidence = false) => ({
    index,
    status,
    reason,
    documents: evidence ? documents : [],
  });
  const branches = partial
    ? [branch(0, 'evidence', null, true), branch(1, 'failed', 'wait_timeout'), branch(2, 'no-match', null)]
    : [
        branch(
          0,
          scenario === 'knowledge-unavailable'
            ? 'unavailable'
            : scenario === 'knowledge-empty'
              ? 'no-match'
              : 'evidence',
          null,
          scenario === 'knowledge',
        ),
      ];
  const output =
    running || scenario === 'knowledge-failed' || scenario === 'knowledge-cancelled'
      ? null
      : scenario === 'knowledge-exhausted'
        ? { result: { provider: 'knowledge', error: 'knowledge-budget-exhausted' } }
        : { result: { provider: 'knowledge', action, branches } };
  const status = running ? 'running' : scenario === 'knowledge-failed' ? 'failed' : 'completed';
  return [
    {
      id,
      sequence: 1,
      author: 'human',
      createdAt,
      parts: [{ kind: 'text', text: 'Understand our pitch and prepare a Google Slides presentation.' }],
      turn: { id, status: running ? 'processing' : 'completed', generation: 0 },
      tools: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          tool,
          status,
          ...(scenario === 'knowledge-cancelled' ? { activityStatus: 'cancelled' } : {}),
          knowledge: knowledgeActivity(tool, { action }, output, status),
        },
      ],
    },
    ...(!running
      ? [
          {
            id: '33333333-3333-4333-8333-333333333333',
            sequence: 2,
            author: 'assistant',
            createdAt,
            turn: null,
            tools: [],
            parts: [
              {
                kind: 'text',
                text:
                  scenario === 'knowledge'
                    ? 'I read the four pitch documents in one search. The evidence is ready. The Google Slides file has not been created.'
                    : 'The knowledge step is shown above. Missing facts must be stated. The Google Slides file has not been created.',
              },
            ],
          },
        ]
      : []),
  ];
}
