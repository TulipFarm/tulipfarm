import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  automationApprovalSchema,
  automationDraftInputSchema,
  automationSetupSchema,
  automationTemplateSchema,
} from '../src/automation-contracts.ts';
import { automationApprovalDigest, renderAutomationMessage, AutomationError } from '../src/automation.ts';

const source = () => ({
  kind: 'github',
  sourceId: randomUUID(),
  generation: 1,
  repositories: { kind: 'repositories', repositoryIds: ['20', '10'] },
  events: [{ event: 'pull_request', actions: ['opened', 'merged'] }],
  baseBranches: { kind: 'selected', names: ['main'] },
  headBranches: { kind: 'all' },
});
const template = () => ({
  fields: ['pullRequest.url', 'pullRequest.title'],
  parts: [
    { kind: 'literal', text: 'PR: ' },
    { kind: 'field', field: 'pullRequest.title' },
    { kind: 'literal', text: '\n' },
    { kind: 'field', field: 'pullRequest.url' },
  ],
});
const setup = () => ({
  source: source(),
  destination: {
    kind: 'slack',
    destinationId: randomUUID(),
    installationId: randomUUID(),
    generation: 1,
    version: 1,
    channelId: 'C123ABC',
    sender: 'app',
  },
  template: template(),
  messagesPerHour: 100,
});
const approval = () => ({
  workflowId: randomUUID(),
  revision: randomUUID(),
  sponsorMembershipId: randomUUID(),
  sponsorshipId: randomUUID(),
  setup: setup(),
  sharing: { approvedByMembershipId: randomUUID(), sourceGeneration: 1, privateRepositoryExport: true },
});

test('setup requires explicit sender, limit and source scope; it never silently approves a default', () => {
  const input = setup();
  assert.equal(automationSetupSchema.parse(input).messagesPerHour, 100);
  for (const key of ['messagesPerHour', 'source', 'destination', 'template']) {
    const copy = { ...input };
    delete copy[key];
    assert.equal(automationSetupSchema.safeParse(copy).success, false, key);
  }
  for (const messagesPerHour of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(automationSetupSchema.safeParse({ ...input, messagesPerHour }).success, false);
  }
  const destination = { ...input.destination };
  delete destination.sender;
  assert.equal(automationSetupSchema.safeParse({ ...input, destination }).success, false);
  assert.equal(automationSetupSchema.safeParse({ ...input, autoApprove: true }).success, false);
});

test('draft version bounds leave room for the next reviewable version', () => {
  const input = {
    commandId: randomUUID(),
    workflowId: randomUUID(),
    expectedRevision: randomUUID(),
    expectedVersion: 0,
    setup: setup(),
  };
  assert.equal(automationDraftInputSchema.safeParse(input).success, true);
  assert.equal(automationDraftInputSchema.safeParse({ ...input, expectedVersion: 2147483645 }).success, true);
  assert.equal(automationDraftInputSchema.safeParse({ ...input, expectedVersion: 2147483646 }).success, false);
});

test('a template exports exactly its reviewed fields and cannot use agent output', () => {
  assert.equal(automationTemplateSchema.safeParse(template()).success, true);
  for (const value of [
    { fields: [], parts: [] },
    { fields: ['pullRequest.title'], parts: [{ kind: 'field', field: 'comment.body' }] },
    { fields: ['pullRequest.title', 'comment.body'], parts: [{ kind: 'field', field: 'pullRequest.title' }] },
    { fields: ['pullRequest.title', 'pullRequest.title'], parts: [{ kind: 'field', field: 'pullRequest.title' }] },
    { fields: [], parts: [{ kind: 'agent', agentId: randomUUID() }] },
    { fields: ['payload'], parts: [{ kind: 'field', field: 'payload' }] },
  ])
    assert.equal(automationTemplateSchema.safeParse(value).success, false);
});

test('approval digest is canonical but binds every authority-bearing choice', () => {
  const input = approval(),
    digest = automationApprovalDigest(input);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(
    automationApprovalDigest({
      ...input,
      setup: {
        ...input.setup,
        template: { ...input.setup.template, fields: [...input.setup.template.fields].reverse() },
        source: { ...input.setup.source, repositories: { kind: 'repositories', repositoryIds: ['10', '20'] } },
      },
    }),
    digest,
  );
  const changes = [
    { ...input, sponsorMembershipId: randomUUID() },
    { ...input, workflowId: randomUUID() },
    { ...input, revision: randomUUID() },
    { ...input, sponsorshipId: randomUUID() },
    { ...input, sharing: { ...input.sharing, approvedByMembershipId: randomUUID() } },
    { ...input, sharing: { ...input.sharing, privateRepositoryExport: false } },
    { ...input, setup: { ...input.setup, messagesPerHour: 101 } },
    { ...input, setup: { ...input.setup, destination: { ...input.setup.destination, sender: 'user' } } },
    { ...input, setup: { ...input.setup, destination: { ...input.setup.destination, channelId: 'C456DEF' } } },
    {
      ...input,
      setup: {
        ...input.setup,
        source: { ...input.setup.source, events: [{ event: 'pull_request', actions: ['closed'] }] },
      },
    },
    {
      ...input,
      setup: {
        ...input.setup,
        source: {
          ...input.setup.source,
          repositories: { kind: 'organization', organizationId: '10', includeFuture: true },
        },
      },
    },
    {
      ...input,
      setup: {
        ...input.setup,
        template: {
          ...input.setup.template,
          parts: [{ kind: 'literal', text: 'Changed ' }, ...input.setup.template.parts],
        },
      },
    },
  ];
  for (const value of changes) assert.notEqual(automationApprovalDigest(value), digest);
  assert.equal(
    automationApprovalSchema.safeParse({ ...input, sharing: { ...input.sharing, sourceGeneration: 2 } }).success,
    false,
  );
});

test('rendered external fields cannot inject Slack mentions or links', () => {
  const value = { fields: ['pullRequest.title'], parts: [{ kind: 'field', field: 'pullRequest.title' }] };
  assert.equal(
    renderAutomationMessage(value, { 'pullRequest.title': '<!channel> <@U123> <https://evil.test|click> & text' }),
    '&lt;!channel&gt; &lt;@U123&gt; &lt;https://evil.test|click&gt; &amp; text',
  );
  assert.equal(
    renderAutomationMessage(template(), {
      'pullRequest.title': 'Fix it',
      'pullRequest.url': 'https://github.com/org/repo/pull/42',
    }),
    'PR: Fix it\nhttps://github.com/org/repo/pull/42',
  );
});

test('missing fields and oversized rendered messages block rather than truncate or invent values', () => {
  const missing = error => error instanceof AutomationError && error.code === 'template-field-missing';
  const oversized = error => error instanceof AutomationError && error.code === 'template-output-too-large';
  assert.throws(() => renderAutomationMessage(template(), { 'pullRequest.title': 'Only a title' }), missing);
  const value = { fields: ['pullRequest.title'], parts: [{ kind: 'field', field: 'pullRequest.title' }] };
  assert.equal(renderAutomationMessage(value, { 'pullRequest.title': 'x'.repeat(4000) }).length, 4000);
  assert.throws(
    () =>
      renderAutomationMessage(
        { ...value, parts: [...value.parts, { kind: 'literal', text: 'x' }] },
        { 'pullRequest.title': 'x'.repeat(4000) },
      ),
    oversized,
  );
  assert.throws(() => renderAutomationMessage(value, { 'pullRequest.title': '<'.repeat(1001) }), oversized);
  assert.throws(() => renderAutomationMessage(value, Object.create({ 'pullRequest.title': 'inherited' })), missing);
});
