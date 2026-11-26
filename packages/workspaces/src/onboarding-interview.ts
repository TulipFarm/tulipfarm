// The onboarding chat's rules: the opening turn, and the turn TulipFarm takes when its model is
// unavailable. The model-driven turn (apps/api public guide) follows the same stages and limits.
import {
  onboardingAgentName,
  onboardingGoals,
  suggestStarterAgents,
  type OnboardingGoalId,
  type OnboardingPersona,
  type StarterAgentId,
} from './onboarding-catalog.ts';
import type { InterviewRequest, InterviewTurn, OnboardingProfile } from './onboarding-contracts.ts';

export const emptyOnboardingProfile: OnboardingProfile = {
  goal: null,
  about: null,
  website: null,
  site: null,
  persona: null,
  answers: [],
  selectedAgents: [],
  agentRequests: [],
};

export const goalQuestion = 'What do you want AI agents to help with first?';
export const goalSuggestions = onboardingGoals.filter(goal => goal.id !== 'other').map(goal => goal.label);
const skipWords = /^(skip|skip for now|pass|no|nope|not now|later|n\/a|none|nothing)[.!]*$/i;

/** A bare "yes" keeps the website's line; a "yes" with more detail is their own description. */
const affirmWords =
  /^(yes|yep|yeah|yup|right|correct|exactly|spot on|that[’']?s (right|it|correct)|sounds (right|good))[.!]*$/i;

export const domainOf = (website: string) => new URL(website).hostname.replace(/^www\./, '');

export const aboutQuestion = (name: string) => `Tell me a little about ${name}: what you do and who it’s for.`;

/**
 * TulipFarm's first message, shown before the visitor types anything. `site` is a short line read from the website's
 * homepage, such as its description; it becomes the draft answer to "about" for the visitor to confirm or correct.
 */
export function openingTurn(
  workspaceName: string,
  website: string | null = null,
  visitorName: string | null = null,
  site: string | null = null,
): Omit<InterviewTurn, 'conversation'> {
  const first = visitorName?.trim().split(/\s+/)[0];
  const line = site?.trim().slice(0, 300) || null;
  const hello = `Hi${first ? ` ${first}` : ''}, I’m ${onboardingAgentName}. Let’s set up ${workspaceName} together.`;
  const ask =
    website && line
      ? `I had a look at ${domainOf(website)}. It says: “${line}” Is that right? Add anything I missed, like who your customers are.`
      : website
        ? `Thanks for sharing ${domainOf(website)}. ${aboutQuestion(workspaceName)}`
        : aboutQuestion(workspaceName);
  return {
    reply: `${hello} ${ask}`,
    stage: 'about',
    profile: {
      ...emptyOnboardingProfile,
      website,
      site: line,
      about: line,
      persona: line ? personaFromText(line, null) : null,
    },
    suggestions: line ? ['That’s right'] : [],
    agents: [],
  };
}

/**
 * Goal choices in the words of the visitor's kind of business, read from what they and their homepage said. Each label
 * maps back to a goal through `goalFromText`. The model writes its own; these are for when it's unavailable.
 */
type BusinessGoal = { label: string; agents: StarterAgentId[] };
const goal = (label: string, ...agents: StarterAgentId[]): BusinessGoal => ({ label, agents });
const goalsByBusiness: [RegExp, BusinessGoal[]][] = [
  [
    /\b(software|saas|app|platform|api|developers?|cloud|startup|tech)\b/i,
    [
      goal('Answer support emails', 'email-replies', 'common-questions', 'customer-list', 'daily-summary'),
      goal('Follow up with trial sign-ups', 'lead-follow-up', 'customer-list', 'email-replies', 'meeting-prep'),
      goal('Prepare for sales calls', 'meeting-prep', 'lead-follow-up', 'customer-list', 'daily-summary'),
      goal('Chase unpaid invoices', 'invoice-tracker', 'expense-log', 'bills-and-renewals', 'daily-summary'),
    ],
  ],
  [
    /\b(restaurants?|caf[eé]s?|bakery|bakes|food|sweets|snacks|catering|kitchen|menu|mithai|namkeen)\b/i,
    [
      goal('Reply to orders and enquiries', 'email-replies', 'common-questions', 'customer-list', 'daily-summary'),
      goal('Get more customer reviews', 'review-requests', 'customer-list', 'email-replies'),
      goal('Track supplier bills', 'bills-and-renewals', 'expense-log', 'invoice-tracker'),
      goal('Answer common questions', 'common-questions', 'email-replies', 'daily-summary'),
    ],
  ],
  [
    /\b(clinic|dental|dentist|doctors?|patients?|therapy|health|salon|spa|physio|gym|fitness)\b/i,
    [
      goal('Reply to patient messages', 'email-replies', 'common-questions', 'daily-summary', 'customer-list'),
      goal('Remind people about appointments', 'daily-summary', 'meeting-prep', 'email-replies'),
      goal('Ask happy clients for reviews', 'review-requests', 'customer-list', 'email-replies'),
      goal('Log expenses', 'expense-log', 'bills-and-renewals', 'invoice-tracker'),
    ],
  ],
  [
    /\b(agency|studio|consult\w*|freelanc\w*|design|marketing|creative)\b/i,
    [
      goal('Follow up with new leads', 'lead-follow-up', 'customer-list', 'meeting-prep', 'review-requests'),
      goal('Reply to client emails', 'email-replies', 'daily-summary', 'customer-list'),
      goal('Prepare for client meetings', 'meeting-prep', 'customer-list', 'daily-summary'),
      goal('Chase unpaid invoices', 'invoice-tracker', 'expense-log', 'bills-and-renewals'),
    ],
  ],
  [
    /\b(shop|store|e-?commerce|retail|boutique|products?|brand)\b/i,
    [
      goal('Answer customer questions', 'email-replies', 'common-questions', 'customer-list'),
      goal('Win back past customers', 'customer-list', 'lead-follow-up', 'review-requests'),
      goal('Get more reviews', 'review-requests', 'customer-list'),
      goal('Log receipts and expenses', 'expense-log', 'bills-and-renewals', 'invoice-tracker'),
    ],
  ],
  [
    /\b(family|kids|household|home)\b/i,
    [
      goal('Run the family calendar', 'family-calendar', 'daily-summary', 'meal-planner'),
      goal('Plan meals and shopping', 'meal-planner', 'family-calendar'),
      goal('Track bills and renewals', 'bills-and-renewals', 'expense-log', 'daily-summary'),
      goal('Sort the inbox each morning', 'daily-summary', 'family-calendar', 'bills-and-renewals'),
    ],
  ],
];

const businessText = (profile: OnboardingProfile) => [profile.about, profile.site].filter(Boolean).join(' ');

export function goalSuggestionsFor(profile: OnboardingProfile) {
  const goals = goalsByBusiness.find(([pattern]) => pattern.test(businessText(profile)))?.[1];
  return goals?.map(goal => goal.label) ?? goalSuggestions;
}

/** Agents for the goal they chose, best first: the goal's own list when they tapped one of their business's choices. */
export function agentsFor(profile: OnboardingProfile): StarterAgentId[] {
  const chosen = profile.goal?.text?.toLowerCase();
  const tailored = goalsByBusiness
    .flatMap(([, goals]) => goals)
    .find(goal => goal.label.toLowerCase() === chosen)?.agents;
  return tailored ?? suggestStarterAgents(profile.goal?.id ?? null).map(agent => agent.id);
}

const goalKeywords: [OnboardingGoalId, RegExp][] = [
  ['household', /\b(family|home|house|household|kids?|children|meals?|groceries|chores|school)\b/i],
  ['customer-messages', /\b(messages?|support|repl(y|ies)|inbox|enquir(y|ies)|inquir(y|ies)|tickets?|questions?)\b/i],
  [
    'admin',
    /\b(admin|paperwork|invoices?|receipts?|bills?|expenses?|accounting|bookkeeping|taxes|scheduling|appointments?)\b/i,
  ],
  ['customers', /\b(customers?|clients?|leads?|sales|sell|marketing|grow|reviews?|prospects?|trials?|sign-?ups)\b/i],
];

export function goalFromText(text: string): OnboardingProfile['goal'] {
  const exact = onboardingGoals.find(goal => goal.label.toLowerCase() === text.trim().toLowerCase());
  if (exact) return { id: exact.id, text: null };
  const match = goalKeywords.find(([, pattern]) => pattern.test(text));
  return { id: match?.[0] ?? 'other', text: text.trim().slice(0, 300) };
}

export function personaFromText(text: string, goal: OnboardingGoalId | null): OnboardingPersona {
  if (goal === 'household' || /\b(family|kids|household|home)\b/i.test(text)) return 'family';
  if (/\b(agency|studio|consultancy)\b/i.test(text)) return 'agency';
  if (/\b(non-?profit|charity|ngo|foundation|volunteers?)\b/i.test(text)) return 'nonprofit';
  if (/\b(freelanc\w*|solo|just me|i'?m an? |sole)\b/i.test(text)) return 'solo';
  return 'small-business';
}

function agentsTurn(name: string, profile: OnboardingProfile, lead: string): Omit<InterviewTurn, 'conversation'> {
  // "answer support emails", when they tapped one of their business's goals.
  const text = profile.goal?.text;
  const aim =
    text && goalsByBusiness.some(([, goals]) => goals.some(goal => goal.label === text))
      ? text[0]!.toLowerCase() + text.slice(1)
      : null;
  return {
    reply: `${lead} Here are agents that could help ${name}${aim ? ` ${aim}` : ''}. Tick the ones you want, or tell me what else you need. Bud will build them with you once you’re in.`,
    stage: 'agents',
    profile,
    suggestions: [],
    agents: agentsFor(profile),
  };
}

/** The next turn without a model: reads the visitor's words with simple rules. */
export function ruleTurn(request: InterviewRequest): Omit<InterviewTurn, 'conversation'> {
  const { message, workspaceName: name, profile } = request;
  const skipped = skipWords.test(message.trim());
  if (request.kind === 'open') return openingTurn(name, profile.website, request.visitorName, profile.site);
  if (request.kind === 'skip')
    return {
      reply: `No problem. Create your account below to save ${name}. Once you’re in, Bud can help you choose agents.`,
      stage: 'signup',
      profile,
      suggestions: [],
      agents: [],
    };
  switch (request.stage) {
    case 'about': {
      const kept = skipped || affirmWords.test(message.trim());
      const about = kept ? profile.about : message.trim().slice(0, 300);
      const next: OnboardingProfile = {
        ...profile,
        about: about ?? null,
        persona: about ? personaFromText(about, null) : profile.persona,
      };
      return {
        reply: `${skipped ? 'No problem.' : 'Thanks, that helps.'} ${goalQuestion}`,
        stage: 'goal',
        profile: next,
        suggestions: goalSuggestionsFor(next),
        agents: [],
      };
    }
    case 'goal':
    case 'follow-up': {
      const next: OnboardingProfile =
        request.stage === 'goal'
          ? { ...profile, goal: skipped ? null : goalFromText(message) }
          : skipped
            ? profile
            : {
                ...profile,
                answers: [...profile.answers, { question: 'Follow-up', answer: message.trim().slice(0, 300) }].slice(
                  -4,
                ),
              };
      if (next.goal?.id === 'household' && profile.persona !== 'family') next.persona = 'family';
      return agentsTurn(name, next, skipped ? 'Okay.' : 'Got it.');
    }
    case 'agents': {
      const next =
        skipped || request.kind === 'agents'
          ? profile
          : { ...profile, agentRequests: [...profile.agentRequests, message.trim().slice(0, 300)].slice(-3) };
      const none = !next.selectedAgents.length && !next.agentRequests.length;
      return {
        reply: none
          ? `No problem. You can add agents any time by asking Bud. Last step: create your account to save ${name}.`
          : `${skipped ? '' : request.kind === 'agents' ? 'Great choice. ' : 'Noted. '}Last step: create your account to save ${name}. Then Bud will start building your agents with you.`,
        stage: 'signup',
        profile: next,
        suggestions: [],
        agents: [],
      };
    }
    case 'signup':
      return {
        reply: `You’re nearly there. Create your account below to save ${name}. Then Bud will start building your agents with you.`,
        stage: 'signup',
        profile,
        suggestions: [],
        agents: [],
      };
  }
}
