// What the onboarding chat asks before sign-up, and the starter agents it can suggest.
// The chat may only suggest agents from this catalog; every card names apps people can
// connect today. Strings were reviewed by the copywriter on 25 November 2026.

export const onboardingAgentName = 'TulipFarm';

export const onboardingGoals = [
  { id: 'customers', label: 'Win more customers' },
  { id: 'customer-messages', label: 'Answer customer messages' },
  { id: 'admin', label: 'Handle admin and paperwork' },
  { id: 'household', label: 'Run the household' },
  { id: 'other', label: 'Something else' },
] as const;
export type OnboardingGoalId = (typeof onboardingGoals)[number]['id'];
export const onboardingGoalIds = onboardingGoals.map(goal => goal.id) as [OnboardingGoalId, ...OnboardingGoalId[]];

export const onboardingPersonas = ['solo', 'small-business', 'agency', 'nonprofit', 'family', 'other'] as const;
export type OnboardingPersona = (typeof onboardingPersonas)[number];

export const aboutPlaceholders: Record<OnboardingGoalId, string> = {
  customers: 'We’re a 4-person bakery taking orders on Instagram.',
  'customer-messages': 'We’re a dental clinic. Patients email us to book and reschedule.',
  admin: 'I’m a freelance designer juggling quotes, invoices and receipts.',
  household: 'We’re a family of four with two jobs, two kids and one calendar.',
  other: 'We’re a 10-person agency building websites for local shops.',
};

export const starterAgents = [
  {
    id: 'lead-follow-up',
    name: 'Lead follow-up',
    description: 'Drafts a follow-up email for each new lead, ready for you to send.',
    goals: ['customers'],
    apps: ['Gmail', 'Google Sheets'],
  },
  {
    id: 'review-requests',
    name: 'Review requests',
    description: 'Drafts emails asking happy customers for a review.',
    goals: ['customers', 'other'],
    apps: ['Gmail', 'Google Sheets'],
  },
  {
    id: 'customer-list',
    name: 'Customer list',
    description: 'Keeps every customer and your last contact with them in one table.',
    goals: ['customers', 'customer-messages'],
    apps: ['Gmail'],
  },
  {
    id: 'meeting-prep',
    name: 'Meeting prep',
    description: 'Before each meeting, sums up who you’re meeting and your last emails.',
    goals: ['customers', 'admin', 'other'],
    apps: ['Google Calendar', 'Gmail'],
  },
  {
    id: 'email-replies',
    name: 'Email replies',
    description: 'Drafts replies to customer emails for you to check and send.',
    goals: ['customer-messages', 'other'],
    apps: ['Gmail'],
  },
  {
    id: 'common-questions',
    name: 'Common questions',
    description: 'Drafts answers to common questions from your own notes and policies.',
    goals: ['customer-messages'],
    apps: ['Google Drive', 'Google Docs'],
  },
  {
    id: 'daily-summary',
    name: 'Daily summary',
    description: 'Each morning, lists the emails and meetings that need you today.',
    goals: ['customer-messages', 'admin', 'household', 'other'],
    apps: ['Gmail', 'Google Calendar'],
  },
  {
    id: 'invoice-tracker',
    name: 'Invoice tracker',
    description: 'Tracks who owes you what and drafts polite payment reminders.',
    goals: ['admin'],
    apps: ['Gmail', 'Google Sheets'],
  },
  {
    id: 'expense-log',
    name: 'Expense log',
    description: 'Logs receipts from your inbox into a spreadsheet.',
    goals: ['admin', 'household'],
    apps: ['Gmail', 'Google Sheets'],
  },
  {
    id: 'bills-and-renewals',
    name: 'Bills and renewals',
    description: 'Tracks bills and renewal dates and reminds you before they’re due.',
    goals: ['admin', 'household'],
    apps: ['Gmail', 'Google Calendar'],
  },
  {
    id: 'family-calendar',
    name: 'Family calendar',
    description: 'Adds plans to your family calendar and drafts a weekly look-ahead.',
    goals: ['household'],
    apps: ['Google Calendar', 'Gmail'],
  },
  {
    id: 'meal-planner',
    name: 'Meal planner',
    description: 'Plans the week’s meals and turns them into a shopping list.',
    goals: ['household', 'other'],
    apps: [],
  },
] as const satisfies readonly {
  id: string;
  name: string;
  description: string;
  goals: readonly OnboardingGoalId[];
  apps: readonly string[];
}[];
export type StarterAgent = (typeof starterAgents)[number];
export type StarterAgentId = StarterAgent['id'];
export const starterAgentIds = starterAgents.map(agent => agent.id) as [StarterAgentId, ...StarterAgentId[]];

/** Starter agents for a goal, in catalog order. No goal suggests the "other" set. */
export function suggestStarterAgents(goal: OnboardingGoalId | null): StarterAgent[] {
  return starterAgents.filter(agent => (agent.goals as readonly OnboardingGoalId[]).includes(goal ?? 'other'));
}
