import { googleAppScopes, type GoogleApp } from '@tulipfarm/google-workspace/public-contracts';
import type { Brand } from '@tulipfarm/sprout/brand-icon';

export type Provider = 'google' | 'slack' | 'github' | 'github-personal' | 'atlassian' | 'trello' | 'workflow' | 'soon';
/** `alsoNeeds` names another Google app whose access this permission depends on. */
export type Permission = { text: string; asksFirst?: boolean; scope?: string; alsoNeeds?: GoogleApp };

export const providers: Record<Exclude<Provider, 'soon'>, { audience: string; can: Permission[] }> = {
  google: {
    audience: 'Only you. Admins can’t see it.',
    can: [{ text: 'See your email address' }],
  },
  slack: {
    audience: 'Selected people and teams. Integration managers control sharing.',
    can: [
      { text: 'Read messages in channels it’s added to' },
      { text: 'Post replies and direct messages' },
      { text: 'Add emoji reactions' },
    ],
  },
  github: {
    audience: 'Selected people and teams. Integration managers grant use and repository access.',
    can: [
      { text: 'Read individually granted issues' },
      {
        text: 'Investigate permitted code, issues, pull requests, Actions, releases, and discussions in private chats and tasks',
      },
    ],
  },
  'github-personal': {
    audience: 'Only you in this workspace. Admins cannot view or use it.',
    can: [
      { text: 'Connect multiple private GitHub identities' },
      { text: 'Read repositories, pull requests, issues, and more' },
      { text: 'Make supported GitHub changes', asksFirst: true },
    ],
  },
  atlassian: {
    audience: 'Your account, or a shared business account.',
    can: [
      { text: 'Read issues and pages in sites you pick' },
      { text: 'Create or edit issues and pages', asksFirst: true },
    ],
  },
  trello: {
    audience: 'Your account, or a shared business account.',
    can: [{ text: 'Read the boards you pick' }, { text: 'Create or move cards', asksFirst: true }],
  },
  workflow: {
    audience: 'People and teams an integration manager shares it with.',
    can: [{ text: 'Watch for new items to start workflows' }],
  },
};

const makers: Partial<Record<Provider, string>> = {
  google: 'Google',
  slack: 'Slack',
  github: 'GitHub',
  'github-personal': 'GitHub',
  atlassian: 'Atlassian',
  trello: 'Atlassian',
};
export const makerOf = (app: Integration) =>
  makers[app.provider] ?? (app.brand.startsWith('google') ? 'Google' : app.name);

export const categories = [
  'Email and calendar',
  'Docs and files',
  'Chat',
  'Code',
  'Projects and issues',
  'CRM and support',
  'Payments and commerce',
] as const;
export type Category = (typeof categories)[number];

export type Integration = {
  id: string;
  name: string;
  brand: Brand;
  category: Category;
  provider: Provider;
  blurb: string;
  prompts: string[];
  recommended?: boolean;
  googleApp?: GoogleApp;
  can?: Permission[];
};

export const integrations: Integration[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    brand: 'gmail',
    category: 'Email and calendar',
    provider: 'google',
    blurb: 'Read, label, and send email',
    prompts: [
      'Draft follow-ups to last week’s leads',
      'Sum up unread mail from customers',
      'Label every invoice email',
    ],
    recommended: true,
    googleApp: 'gmail',
    can: [
      { text: 'Read and label your email', scope: googleAppScopes.gmail[0] },
      { text: 'Send email', asksFirst: true, scope: googleAppScopes.gmail[1] },
    ],
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    brand: 'google-calendar',
    category: 'Email and calendar',
    provider: 'google',
    blurb: 'Read and book events',
    prompts: ['Find 30 minutes with Sam next week', 'What does my Thursday look like?', 'Move my 3 pm call to Friday'],
    recommended: true,
    googleApp: 'calendar',
    can: [
      { text: 'See calendar events', scope: googleAppScopes.calendar[0] },
      { text: 'Change calendar events', asksFirst: true, scope: googleAppScopes.calendar[0] },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    brand: 'slack',
    category: 'Chat',
    provider: 'slack',
    blurb: 'Chat with agents in Slack',
    prompts: ['Post the weekly update in #team', 'Answer questions in #support', 'DM me when a big order lands'],
    recommended: true,
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    brand: 'google-drive',
    category: 'Docs and files',
    provider: 'google',
    blurb: 'Find and read files',
    prompts: ['Find the latest pricing sheet', 'Pull the Q3 report into chat', 'Tidy the Clients folder'],
    recommended: true,
    googleApp: 'drive',
    can: [
      { text: 'Find and read files', scope: googleAppScopes.drive[0] },
      { text: 'Change files', asksFirst: true, scope: googleAppScopes.drive[0] },
    ],
  },
  {
    id: 'github',
    name: 'GitHub team',
    brand: 'github',
    category: 'Code',
    provider: 'github',
    blurb: 'Investigate permitted repositories',
    prompts: [
      'Investigate this bug across related repositories',
      'Read this issue using my team integration',
      'Explain this failed Actions run',
    ],
  },
  {
    id: 'github-personal',
    name: 'GitHub',
    brand: 'github',
    category: 'Code',
    provider: 'github-personal',
    blurb: 'Work in your private repos',
    prompts: ['What changed in main this week?', 'List my open pull requests', 'Find issues assigned to me'],
    recommended: true,
  },
  {
    id: 'jira',
    name: 'Jira',
    brand: 'jira',
    category: 'Projects and issues',
    provider: 'atlassian',
    blurb: 'Read and update issues',
    prompts: ['Triage new bugs from today', 'Show what slipped this sprint', 'Write a status note for the team'],
    recommended: true,
  },
  {
    id: 'google-sheets',
    name: 'Google Sheets',
    brand: 'google-sheets',
    category: 'Docs and files',
    provider: 'google',
    blurb: 'Read and update rows',
    prompts: ['Add today’s orders to the tracker', 'Flag rows with missing emails', 'Sum sales by region'],
    googleApp: 'sheets',
    can: [
      { text: 'Read spreadsheets', scope: googleAppScopes.sheets[0] },
      { text: 'Change spreadsheets', asksFirst: true, scope: googleAppScopes.sheets[0], alsoNeeds: 'drive' },
    ],
  },
  {
    id: 'google-docs',
    name: 'Google Docs',
    brand: 'google-docs',
    category: 'Docs and files',
    provider: 'google',
    blurb: 'Write and edit documents',
    prompts: ['Draft a proposal for Acme', 'Turn these notes into a brief', 'Fix the tone of this doc'],
    googleApp: 'docs',
    can: [
      { text: 'Read documents', scope: googleAppScopes.docs[0] },
      { text: 'Change documents', asksFirst: true, scope: googleAppScopes.docs[0] },
    ],
  },
  {
    id: 'google-slides',
    name: 'Google Slides',
    brand: 'google-slides',
    category: 'Docs and files',
    provider: 'google',
    blurb: 'Create and edit slides',
    prompts: ['Make a 5-slide sales deck', 'Update the numbers on slide 3', 'Turn this doc into slides'],
    googleApp: 'slides',
    can: [
      { text: 'Read presentations', scope: googleAppScopes.slides[0] },
      { text: 'Change presentations', asksFirst: true, scope: googleAppScopes.slides[0] },
    ],
  },
  {
    id: 'confluence',
    name: 'Confluence',
    brand: 'confluence',
    category: 'Docs and files',
    provider: 'atlassian',
    blurb: 'Search and write pages',
    prompts: ['What does our refund policy say?', 'Draft an onboarding page', 'Find the release checklist'],
  },
  {
    id: 'trello',
    name: 'Trello',
    brand: 'trello',
    category: 'Projects and issues',
    provider: 'trello',
    blurb: 'Track and move cards',
    prompts: ['Move done cards to Shipped', 'Add a card for each new lead', 'What is stuck in Review?'],
  },
  {
    id: 'notion',
    name: 'Notion',
    brand: 'notion',
    category: 'Docs and files',
    provider: 'soon',
    blurb: 'Start workflows from new pages',
    prompts: [],
  },
  {
    id: 'google-forms',
    name: 'Google Forms',
    brand: 'google-forms',
    category: 'CRM and support',
    provider: 'soon',
    blurb: 'Start workflows from responses',
    prompts: [],
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    brand: 'hubspot',
    category: 'CRM and support',
    provider: 'soon',
    blurb: 'Start workflows from new CRM records',
    prompts: [],
  },
  {
    id: 'microsoft-365',
    name: 'Microsoft 365',
    brand: 'microsoft',
    category: 'Email and calendar',
    provider: 'soon',
    blurb: 'Outlook, Teams, and OneDrive',
    prompts: [],
  },
  {
    id: 'calendly',
    name: 'Calendly',
    brand: 'calendly',
    category: 'Email and calendar',
    provider: 'soon',
    blurb: 'Read and book meetings',
    prompts: [],
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    brand: 'dropbox',
    category: 'Docs and files',
    provider: 'soon',
    blurb: 'Find and share files',
    prompts: [],
  },
  {
    id: 'airtable',
    name: 'Airtable',
    brand: 'airtable',
    category: 'Docs and files',
    provider: 'soon',
    blurb: 'Read and update bases',
    prompts: [],
  },
  {
    id: 'figma',
    name: 'Figma',
    brand: 'figma',
    category: 'Docs and files',
    provider: 'soon',
    blurb: 'Read files and comments',
    prompts: [],
  },
  {
    id: 'discord',
    name: 'Discord',
    brand: 'discord',
    category: 'Chat',
    provider: 'soon',
    blurb: 'Chat with agents in Discord',
    prompts: [],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    brand: 'gitlab',
    category: 'Code',
    provider: 'soon',
    blurb: 'Read issues and merge requests',
    prompts: [],
  },
  {
    id: 'linear',
    name: 'Linear',
    brand: 'linear',
    category: 'Projects and issues',
    provider: 'soon',
    blurb: 'Read and update issues',
    prompts: [],
  },
  {
    id: 'asana',
    name: 'Asana',
    brand: 'asana',
    category: 'Projects and issues',
    provider: 'soon',
    blurb: 'Track tasks and projects',
    prompts: [],
  },
  {
    id: 'clickup',
    name: 'ClickUp',
    brand: 'clickup',
    category: 'Projects and issues',
    provider: 'soon',
    blurb: 'Read and update tasks',
    prompts: [],
  },
  {
    id: 'zendesk',
    name: 'Zendesk',
    brand: 'zendesk',
    category: 'CRM and support',
    provider: 'soon',
    blurb: 'Triage support tickets',
    prompts: [],
  },
  {
    id: 'stripe',
    name: 'Stripe',
    brand: 'stripe',
    category: 'Payments and commerce',
    provider: 'soon',
    blurb: 'Read payments and invoices',
    prompts: [],
  },
  {
    id: 'shopify',
    name: 'Shopify',
    brand: 'shopify',
    category: 'Payments and commerce',
    provider: 'soon',
    blurb: 'Read orders and products',
    prompts: [],
  },
];

export const integrationTabs = ['overview', 'accounts', 'knowledge', 'channels', 'settings', 'advanced'] as const;
export type IntegrationTab = (typeof integrationTabs)[number];

const legacyHashes: Record<string, { id: string; tab: IntegrationTab }> = {
  'google-workspace': { id: 'gmail', tab: 'accounts' },
  'google-proposals-heading': { id: 'gmail', tab: 'accounts' },
  'github-integrations': { id: 'github', tab: 'settings' },
  'github-accounts': { id: 'github-personal', tab: 'accounts' },
  'slack-account': { id: 'slack', tab: 'accounts' },
  'atlassian-heading': { id: 'jira', tab: 'accounts' },
  'trello-accounts': { id: 'trello', tab: 'accounts' },
};
/** Maps an old `/integrations#…` sheet link to its integration page and tab. */
export function integrationFromHash(hash: string) {
  const legacy = legacyHashes[hash];
  const app = integrations.find(item => item.id === (legacy?.id ?? hash));
  return app ? { app, tab: legacy?.tab ?? ('overview' as const) } : null;
}
export const integrationById = (id: string) => integrations.find(item => item.id === id);
