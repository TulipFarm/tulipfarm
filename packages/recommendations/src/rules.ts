import {
  generatedPromptsSchema,
  recommendationItemsSchema,
  recommendationLimit,
  type Recommendation,
} from './contracts.ts';

export type RecommendationSignals = {
  slack: boolean;
  google: boolean;
  github: boolean;
  table: { label: string } | null;
  workflow: boolean;
  knowledge: boolean;
  teammates: boolean;
  connected?: boolean;
  gmail?: boolean;
  googleCalendar?: boolean;
  personalized?: boolean;
  indexedProviders?: string[];
  indexableProviders?: string[];
};

const prompt = (text: string) => ({ kind: 'prompt' as const, prompt: text });
const open = (destination: 'integrations' | 'files' | 'members') => ({ kind: 'open' as const, destination });

export const fallbackRecommendations: Recommendation[] = [
  {
    id: 'follow-ups',
    kind: 'prompt',
    label: 'Plan customer follow-ups',
    brands: [],
    action: prompt(
      'Help me plan customer follow-ups. Ask me about my customers and current process, then give me a short checklist with next actions. Do not send messages or change rows.',
    ),
  },
  {
    id: 'support',
    kind: 'prompt',
    label: 'Draft a support reply',
    brands: [],
    action: prompt(
      'Help me draft a reply to a customer support request. Ask me to paste the request and our relevant policy, then write a draft for my review. Do not send it.',
    ),
  },
  {
    id: 'week',
    kind: 'prompt',
    label: 'Plan my week',
    brands: [],
    action: prompt(
      'Help me plan my week. Ask about my priorities, deadlines, and meetings, then suggest a short plan with the most important tasks first.',
    ),
  },
  {
    id: 'standup',
    kind: 'prompt',
    label: 'Prepare a daily team update',
    brands: [],
    action: prompt(
      'Help me prepare a short daily team update. Ask what the team finished, what is next, and what is blocked, then show me the draft. Do not post or send it.',
    ),
  },
  {
    id: 'process',
    kind: 'prompt',
    label: 'Write down a business process',
    brands: [],
    action: prompt(
      'Help me write down one of my business processes. Ask me how it works step by step, then summarize it as a clear checklist.',
    ),
  },
];

export function recommend(signals: RecommendationSignals) {
  const onboarding: (Recommendation & { done: boolean })[] = [
    {
      id: 'personalize-bud',
      kind: 'onboarding',
      label: 'Set how Bud replies to you',
      brands: [],
      action: prompt(
        'Ask me how I want you to reply, using bud.preference.ask for reply-style. Ask only one short question.',
      ),
      done: signals.personalized !== false,
    },
    {
      id: 'connect-apps',
      kind: 'onboarding',
      label: 'Connect Slack, Google, or GitHub',
      brands: [],
      action: open('integrations'),
      done: signals.connected === true || signals.slack || signals.google || signals.github,
    },
    ...(['github', 'slack', 'google'] as const)
      .filter(
        provider =>
          signals.indexedProviders !== undefined &&
          signals.indexableProviders?.includes(provider) &&
          !signals.indexedProviders.includes(provider),
      )
      .map(provider => ({
        id: `index-${provider}`,
        kind: 'onboarding' as const,
        label: `Choose ${provider === 'github' ? 'GitHub repositories' : provider === 'slack' ? 'Slack channels' : 'Google sources'} for knowledge`,
        brands: provider === 'google' ? [] : [provider],
        action: { kind: 'open' as const, destination: 'integrations' as const, sourcePicker: provider },
        done: false,
      })),
    {
      id: 'create-table',
      kind: 'onboarding',
      label: 'Create your first business table',
      brands: [],
      action: prompt(
        'Help me create my first business table. Ask what I need to track, then propose a table with useful fields for my review. Do not add rows yet.',
      ),
      done: signals.table !== null,
    },
    {
      id: 'create-workflow',
      kind: 'onboarding',
      label: 'Create your first Workflow',
      brands: [],
      action: prompt(
        'Help me create my first Workflow. Ask which repeated task I want to automate, then propose a Workflow for my review. Do not activate it.',
      ),
      done: signals.workflow,
    },
    {
      id: 'add-knowledge',
      kind: 'onboarding',
      label: 'Add knowledge about your business',
      brands: [],
      action: open('files'),
      done: signals.knowledge,
    },
    {
      id: 'invite-teammate',
      kind: 'onboarding',
      label: 'Invite a teammate',
      brands: [],
      action: open('members'),
      done: signals.teammates,
    },
  ];
  const pending = onboarding.filter(item => !item.done).map(({ done: _done, ...item }) => item);
  const label = signals.table?.label.slice(0, 120);
  const prompts: Recommendation[] = [
    ...((signals.googleCalendar ?? signals.google)
      ? [
          {
            id: 'meetings',
            kind: 'prompt' as const,
            label: "Prepare me for tomorrow's meetings",
            brands: ['google-calendar' as const],
            action: prompt(
              "Read tomorrow's meetings from Google Calendar. For each one, list who is attending, the goal, and what I should prepare. Do not create, change, or send anything.",
            ),
          },
        ]
      : []),
    ...((signals.gmail ?? signals.google)
      ? [
          {
            id: 'inbox',
            kind: 'prompt' as const,
            label: 'Draft replies to recent customer emails',
            brands: ['gmail' as const],
            action: prompt(
              'Find recent customer emails in Gmail that still need a reply. Draft a short reply to each one for my review. Do not send anything.',
            ),
          },
        ]
      : []),
    ...(label
      ? [
          {
            id: 'table-review',
            kind: 'prompt' as const,
            label: `Review rows in ${label}`,
            brands: [],
            action: prompt(
              `Review the rows in the ${label} table. Point out rows that look overdue, incomplete, or need follow-up, and suggest next actions. Do not change any rows.`,
            ),
          },
        ]
      : []),
    ...(signals.github
      ? [
          {
            id: 'github',
            kind: 'prompt' as const,
            label: 'Summarize my open GitHub work',
            brands: ['github' as const],
            action: prompt(
              'Summarize my open GitHub issues and pull requests. Group them by repository and list what needs my attention first. Do not change anything.',
            ),
          },
        ]
      : []),
    ...(signals.slack
      ? [
          {
            id: 'slack-update',
            kind: 'prompt' as const,
            label: 'Draft a Slack update for my team',
            brands: ['slack' as const],
            action: prompt(
              'Help me draft a short team update for Slack. Ask what happened today, then show me the draft. Do not post it until I approve.',
            ),
          },
        ]
      : []),
    ...(signals.knowledge
      ? [
          {
            id: 'knowledge',
            kind: 'prompt' as const,
            label: 'Ask a question about my business',
            brands: [],
            action: prompt('Ask me what I want to know, then search my knowledge and answer with citations.'),
          },
        ]
      : []),
    ...(signals.workflow
      ? [
          {
            id: 'workflows',
            kind: 'prompt' as const,
            label: 'Review my Workflows',
            brands: [],
            action: prompt(
              'List the Workflows I can access and suggest improvements or new Workflows that would save me time. Do not change or activate anything.',
            ),
          },
        ]
      : []),
    ...fallbackRecommendations,
  ];
  return {
    onboarding: pending.length > 0,
    items: recommendationItemsSchema.parse([...pending, ...prompts].slice(0, recommendationLimit)),
  };
}

export function combineRecommendations(signals: RecommendationSignals, generated: unknown) {
  const rules = recommend(signals);
  const candidates = generatedPromptsSchema.parse(generated);
  const items = rules.items.filter(item => item.kind === 'onboarding');
  const key = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
  const fillers = [...items, ...fallbackRecommendations];
  const reserved = new Set(fillers.map(item => item.id));
  const append = (item: Recommendation) => {
    if (
      items.length === recommendationLimit ||
      items.some(
        prior =>
          prior.id === item.id ||
          key(prior.label) === key(item.label) ||
          (prior.action.kind === 'prompt' &&
            item.action.kind === 'prompt' &&
            key(prior.action.prompt) === key(item.action.prompt)),
      )
    )
      return;
    items.push(item);
  };
  for (const { sources: _sources, ...item } of candidates) {
    if (
      !reserved.has(item.id) &&
      !fillers.some(
        filler =>
          key(filler.label) === key(item.label) ||
          (filler.action.kind === 'prompt' && key(filler.action.prompt) === key(item.action.prompt)),
      )
    )
      append(item);
  }
  for (const item of fallbackRecommendations) append(item);
  if (items.length !== recommendationLimit) throw new Error('Incomplete recommendation list');
  return { onboarding: rules.onboarding, items: recommendationItemsSchema.parse(items) };
}
