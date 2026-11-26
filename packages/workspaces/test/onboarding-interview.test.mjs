import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentsFor,
  emptyOnboardingProfile,
  goalFromText,
  goalSuggestions,
  goalSuggestionsFor,
  openingTurn,
  ruleTurn,
} from '../src/onboarding-interview.ts';

const request = (stage, message, profile, kind = 'message') => ({
  message,
  kind,
  stage,
  profile,
  workspaceName: 'Basecamp',
  visitorName: 'Asha Rao',
});

test('the opening asks about the business and offers the website line to confirm', () => {
  const turn = openingTurn('Basecamp', 'https://basecamp.com/', 'Asha Rao', 'Project management for small teams.');
  assert.equal(turn.stage, 'about');
  assert.match(turn.reply, /^Hi Asha, /);
  assert.match(turn.reply, /basecamp\.com\. It says: “Project management for small teams\.” Is that right\?/);
  assert.deepEqual(turn.suggestions, ['That’s right']);
  assert.equal(turn.profile.about, 'Project management for small teams.');

  const unread = openingTurn('Basecamp', 'https://basecamp.com/', null, null);
  assert.match(unread.reply, /Thanks for sharing basecamp\.com\. Tell me a little about Basecamp/);
  assert.deepEqual(unread.suggestions, []);
});

test('a bare yes keeps the website line, and a yes with detail keeps their words', () => {
  const profile = { ...emptyOnboardingProfile, about: 'Project management for small teams.' };
  assert.equal(ruleTurn(request('about', 'Yes!', profile)).profile.about, profile.about);
  assert.equal(ruleTurn(request('about', 'That’s right', profile)).profile.about, profile.about);
  const own = 'Yes. We sell project management software to agencies.';
  assert.equal(ruleTurn(request('about', own, profile)).profile.about, own);
});

test('goal choices follow the kind of business, and each maps back to a goal', () => {
  const choices = about => goalSuggestionsFor({ ...emptyOnboardingProfile, about });
  assert.deepEqual(choices('The easiest project management platform.'), [
    'Answer support emails',
    'Follow up with trial sign-ups',
    'Prepare for sales calls',
    'Chase unpaid invoices',
  ]);
  assert.equal(choices('Sweets and namkeen since 1937.')[0], 'Reply to orders and enquiries');
  assert.equal(choices('A dental clinic in Pune.')[0], 'Reply to patient messages');
  assert.deepEqual(choices('Something unusual.'), goalSuggestions);
  assert.deepEqual(
    choices('The easiest project management platform.').map(label => goalFromText(label).id),
    ['customer-messages', 'customers', 'customers', 'admin'],
  );
  const next = ruleTurn(
    request('about', 'That’s right', { ...emptyOnboardingProfile, about: 'A dental clinic in Pune.' }),
  );
  assert.equal(next.stage, 'goal');
  assert.equal(next.suggestions[0], 'Reply to patient messages');
});

test('the agent checklist follows the goal they tapped', () => {
  const profile = { ...emptyOnboardingProfile, about: 'The easiest project management platform.' };
  const turn = ruleTurn(request('goal', 'Answer support emails', profile));
  assert.equal(turn.stage, 'agents');
  assert.deepEqual(turn.agents, ['email-replies', 'common-questions', 'customer-list', 'daily-summary']);
  assert.match(turn.reply, /help Basecamp answer support emails\./);

  const typed = ruleTurn(request('goal', 'win more customers please', profile));
  assert.deepEqual(typed.agents, agentsFor({ ...profile, goal: { id: 'customers', text: null } }));
  assert.doesNotMatch(typed.reply, /help Basecamp win/);
});

test('skipping jumps to sign-up and picking agents promises Bud will build them', () => {
  const skipped = ruleTurn(request('goal', '', emptyOnboardingProfile, 'skip'));
  assert.equal(skipped.stage, 'signup');
  const picked = ruleTurn(
    request(
      'agents',
      'I’d like Email replies.',
      { ...emptyOnboardingProfile, selectedAgents: ['email-replies'] },
      'agents',
    ),
  );
  assert.equal(picked.stage, 'signup');
  assert.match(picked.reply, /Bud will start building your agents with you\.$/);
});
