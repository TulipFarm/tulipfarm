// The onboarding chat's rules: the opening turn, and the turn TulipFarm takes when its model is
// unavailable. The model-driven turn (apps/api public guide) follows the same stages and limits.
import {
  onboardingAgentName,
  onboardingGoals,
  suggestStarterAgents,
  type OnboardingGoalId,
  type OnboardingPersona,
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

const goalKeywords: [OnboardingGoalId, RegExp][] = [
  ['household', /\b(family|home|house|household|kids?|children|meals?|groceries|chores|school)\b/i],
  ['customer-messages', /\b(messages?|support|repl(y|ies)|inbox|enquir(y|ies)|inquir(y|ies)|tickets?|questions?)\b/i],
  ['admin', /\b(admin|paperwork|invoices?|receipts?|bills?|expenses?|accounting|bookkeeping|taxes|scheduling)\b/i],
  ['customers', /\b(customers?|clients?|leads?|sales|sell|marketing|grow|reviews?|prospects?)\b/i],
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
  return {
    reply: `${lead} Here are agents that could help ${name}. Tick the ones you want, or tell me what else you need. Bud will build them with you once you’re in.`,
    stage: 'agents',
    profile,
    suggestions: [],
    agents: suggestStarterAgents(profile.goal?.id ?? null).map(agent => agent.id),
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
        suggestions: goalSuggestions,
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
