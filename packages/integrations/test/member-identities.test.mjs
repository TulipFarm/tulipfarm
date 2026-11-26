import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  externalProfileUrl,
  formatExternalMention,
  hasMemberIdentities,
  identityProviderList,
  MemberIdentityError,
  memberIdentitySchema,
  normalizeExternalHandle,
  normalizeExternalId,
  normalizeExternalProvider,
  normalizeExternalScope,
} from '../src/member-identities.ts';

const rejects = (run, code, status) =>
  assert.throws(run, error => error instanceof MemberIdentityError && error.code === code && error.status === status);

test('providers normalize to lowercase slugs and reject anything else', () => {
  assert.equal(normalizeExternalProvider('  GitHub '), 'github');
  assert.equal(normalizeExternalProvider('rocket-chat'), 'rocket-chat');
  for (const raw of ['', '1password', 'git hub', 'git_hub', 'a'.repeat(33), 'gïthub'])
    rejects(() => normalizeExternalProvider(raw), 'provider-invalid', 400);
});

test('scopes default per provider, and Slack falls back to the installed team, then to slack', () => {
  assert.equal(normalizeExternalScope('github'), 'github.com');
  assert.equal(normalizeExternalScope('github', ' enterprise.example.com '), 'enterprise.example.com');
  assert.equal(normalizeExternalScope('discord', null), 'discord.com');
  assert.equal(normalizeExternalScope('slack', '', 'T0123ABC'), 'T0123ABC');
  assert.equal(normalizeExternalScope('slack', null, null), 'slack');
  assert.equal(normalizeExternalScope('slack', 'T999', 'T0123ABC'), 'T999');
  assert.equal(normalizeExternalScope('rocket-chat'), 'rocket-chat');
  for (const raw of ['-leading', 'has space', 'slash/path', 'x'.repeat(129)])
    rejects(() => normalizeExternalScope('github', raw), 'scope-invalid', 400);
});

test('handles drop one leading @ and reject whitespace, control characters and bare @', () => {
  assert.equal(normalizeExternalHandle('github', ' @Octocat '), 'Octocat');
  assert.equal(normalizeExternalHandle('teams', 'ada@example.com'), 'ada@example.com');
  assert.equal(normalizeExternalHandle('telegram', 'durov'), 'durov');
  for (const raw of ['', '@', '@@double', 'two words', 'tab\there', 'bell\u0007', 'del\u007f', 'h'.repeat(129)])
    rejects(() => normalizeExternalHandle('github', raw), 'handle-invalid', 400);
  rejects(() => normalizeExternalHandle('Not A Provider', 'octocat'), 'provider-invalid', 400);
});

test('external ids are trimmed printable ASCII up to 128 characters', () => {
  assert.equal(normalizeExternalId(' U012AB3CD '), 'U012AB3CD');
  assert.equal(normalizeExternalId('557058:f4d5-e6'), '557058:f4d5-e6');
  for (const raw of ['', ' ', 'has space', 'ünicode', 'x'.repeat(129)])
    rejects(() => normalizeExternalId(raw), 'external-id-invalid', 400);
});

test('mentions use the provider convention for each identity', () => {
  const mention = (provider, externalId, handle) => formatExternalMention({ provider, externalId, handle });
  assert.equal(mention('slack', 'U012AB3CD', 'ada'), '<@U012AB3CD>');
  assert.equal(mention('slack', null, 'ada'), '@ada');
  assert.equal(mention('discord', '80351110224678912', 'ada'), '<@80351110224678912>');
  assert.equal(mention('github', '583231', 'octocat'), '@octocat');
  assert.equal(mention('github', '583231', null), null);
  assert.equal(mention('google', '1089', 'ada@example.com'), 'ada@example.com');
  assert.equal(mention('telegram', null, 'durov'), '@durov');
  assert.equal(mention('teams', null, 'ada@example.com'), '@ada@example.com');
  assert.equal(mention('linkedin', null, 'ada-lovelace'), null);
  assert.equal(mention('rocket-chat', null, 'ada'), 'ada');
});

test('profile links exist only where the provider has a public profile URL', () => {
  const profile = (provider, handle) => externalProfileUrl({ provider, externalId: null, handle });
  assert.equal(profile('github', 'octocat'), 'https://github.com/octocat');
  assert.equal(profile('x', 'jack'), 'https://x.com/jack');
  assert.equal(profile('telegram', 'durov'), 'https://t.me/durov');
  assert.equal(profile('trello', 'ada'), 'https://trello.com/ada');
  assert.equal(profile('linkedin', 'ada lovelace'), 'https://www.linkedin.com/in/ada%20lovelace');
  assert.equal(profile('github', null), null);
  assert.equal(profile('slack', 'ada'), null);
  assert.equal(profile('discord', 'ada'), null);
  assert.equal(profile('rocket-chat', 'ada'), null);
});

test('the provider list is what dropdowns render, and Google cannot be added by hand', () => {
  assert.deepEqual(identityProviderList, [
    { id: 'github', label: 'GitHub', defaultScope: 'github.com', handlePrefix: '@', supportsManual: true },
    { id: 'slack', label: 'Slack', defaultScope: null, handlePrefix: '@', supportsManual: true },
    { id: 'google', label: 'Google', defaultScope: 'accounts.google.com', handlePrefix: null, supportsManual: false },
    { id: 'atlassian', label: 'Atlassian', defaultScope: 'atlassian.com', handlePrefix: null, supportsManual: true },
    { id: 'trello', label: 'Trello', defaultScope: 'trello.com', handlePrefix: '@', supportsManual: true },
    { id: 'discord', label: 'Discord', defaultScope: 'discord.com', handlePrefix: '@', supportsManual: true },
    { id: 'telegram', label: 'Telegram', defaultScope: 'telegram.org', handlePrefix: '@', supportsManual: true },
    {
      id: 'teams',
      label: 'Microsoft Teams',
      defaultScope: 'teams.microsoft.com',
      handlePrefix: null,
      supportsManual: true,
    },
    { id: 'linear', label: 'Linear', defaultScope: 'linear.app', handlePrefix: '@', supportsManual: true },
    { id: 'x', label: 'X', defaultScope: 'x.com', handlePrefix: '@', supportsManual: true },
    { id: 'linkedin', label: 'LinkedIn', defaultScope: 'linkedin.com', handlePrefix: null, supportsManual: true },
  ]);
});

test('object prototype names are custom providers, not registry lookups', () => {
  assert.equal(normalizeExternalScope('constructor'), 'constructor');
  assert.equal(formatExternalMention({ provider: 'constructor', externalId: null, handle: 'ada' }), 'ada');
});

test('errors carry the HTTP status the API returns', () => {
  const statuses = Object.fromEntries(
    [
      'provider-invalid',
      'manual-not-allowed',
      'identity-incomplete',
      'identity-claimed',
      'identity-not-found',
      'member-not-found',
      'unsupported',
    ].map(code => [code, new MemberIdentityError(code).status]),
  );
  assert.deepEqual(statuses, {
    'provider-invalid': 400,
    'manual-not-allowed': 400,
    'identity-incomplete': 400,
    'identity-claimed': 409,
    'identity-not-found': 404,
    'member-not-found': 404,
    unsupported: 503,
  });
});

test('identities need workspace storage at version 120', () => {
  assert.equal(hasMemberIdentities({}), false);
  assert.equal(hasMemberIdentities({ commonVersion: 119 }), false);
  assert.equal(hasMemberIdentities({ commonVersion: 120 }), true);
});

test('the wire schema rejects unknown trust and conflict values', () => {
  const identity = {
    id: null,
    memberId: '6f1c4f3e-1d2b-4c5a-9e8f-0a1b2c3d4e5f',
    membershipId: null,
    provider: 'github',
    providerLabel: 'GitHub',
    scope: 'github.com',
    externalId: '583231',
    handle: 'octocat',
    displayName: null,
    aliases: ['octo-old'],
    trust: 'verified',
    conflict: null,
    profileUrl: 'https://github.com/octocat',
    mention: '@octocat',
    updatedAt: null,
  };
  assert.deepEqual(memberIdentitySchema.parse(identity), identity);
  assert.equal(memberIdentitySchema.safeParse({ ...identity, trust: 'guessed' }).success, false);
  assert.equal(memberIdentitySchema.safeParse({ ...identity, conflict: 'other' }).success, false);
});
