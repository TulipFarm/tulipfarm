import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectRecommendationContext,
  combineRecommendations,
  fallbackRecommendations,
  readSavedRecommendations,
  recommend,
  recommendationContextFingerprint,
  recommendationFacts,
  recommendationPolicy,
  validateGeneratedRecommendations,
} from '../dist/index.js';

const fresh = {
  slack: false,
  google: false,
  github: false,
  table: null,
  workflow: false,
  knowledge: false,
  teammates: false,
};
const complete = {
  slack: true,
  google: true,
  github: true,
  table: { label: 'Customers' },
  workflow: true,
  knowledge: true,
  teammates: true,
};
const memberId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const tableId = '10000000-0000-4000-8000-000000000003';
const entry = (kind = 'memory', id = memberId) => ({
  kind,
  id,
  key: `${kind}:${id}`,
  revision: '1',
  digest: 'content-hash',
  label: 'My preferences',
  content: 'Use short checklists.',
  capabilities: [],
});
const context = (entries = [entry()], signals = fresh) => ({ policy: recommendationPolicy, entries, signals });
const generated = (overrides = {}) => ({
  id: 'generated-1',
  kind: 'prompt',
  label: 'Plan a short checklist',
  brands: [],
  action: { kind: 'prompt', prompt: 'Help me plan a short checklist. Ask which process first.' },
  sources: [`memory:${memberId}`],
  ...overrides,
});

test('indexing uses personal provider pickers and only relevant changes revive a suggestion', () => {
  const signals = {
    ...complete,
    personalized: true,
    indexedProviders: ['google'],
    indexableProviders: ['github', 'slack', 'google'],
  };
  const result = recommend(signals);
  assert.deepEqual(
    result.items.slice(0, 2).map(item => item.action),
    [
      { kind: 'open', destination: 'integrations', sourcePicker: 'github' },
      { kind: 'open', destination: 'integrations', sourcePicker: 'slack' },
    ],
  );
  const github = { ...entry('integration', 'github-account'), provider: 'github' };
  const slack = { ...entry('integration', 'slack-account'), provider: 'slack' };
  const item = result.items[0];
  const original = recommendationFacts(context([github, slack], signals), item);
  assert.equal(original, recommendationFacts(context([github, { ...slack, revision: '2' }], signals), item));
  assert.notEqual(original, recommendationFacts(context([{ ...github, revision: '2' }, slack], signals), item));
  assert.equal(
    recommend({ ...signals, indexableProviders: [] }).items.some(item => item.id.startsWith('index-')),
    false,
  );
});

test('every deterministic and generated combination fills exactly five slots with onboarding first', () => {
  for (let mask = 0; mask < 128; mask++) {
    const signals = {
      slack: !!(mask & 1),
      google: !!(mask & 2),
      github: !!(mask & 4),
      table: mask & 8 ? { label: 'Customers' } : null,
      workflow: !!(mask & 16),
      knowledge: !!(mask & 32),
      teammates: !!(mask & 64),
    };
    const rules = recommend(signals);
    const combined = combineRecommendations(signals, [generated()]);
    assert.equal(rules.items.length, 5);
    assert.equal(combined.items.length, 5);
    assert.equal(new Set(combined.items.map(item => item.id)).size, 5);
    assert.deepEqual(
      combined.items.filter(item => item.kind === 'onboarding'),
      rules.items.filter(item => item.kind === 'onboarding'),
    );
    assert.equal(
      combined.onboarding,
      combined.items.some(item => item.kind === 'onboarding'),
    );
    const firstPrompt = combined.items.findIndex(item => item.kind === 'prompt');
    if (firstPrompt >= 0) {
      assert.equal(combined.items[firstPrompt].id, 'generated-1');
      assert.deepEqual(combined.items.slice(firstPrompt + 1), fallbackRecommendations.slice(0, 4 - firstPrompt));
    }
  }
  assert.deepEqual(
    recommend(fresh).items.map(item => item.id),
    ['connect-apps', 'create-table', 'create-workflow', 'add-knowledge', 'invite-teammate'],
  );
  assert.deepEqual(combineRecommendations(complete, []).items, fallbackRecommendations);
  assert.deepEqual(
    combineRecommendations(complete, [generated()]).items.map(item => item.id),
    ['generated-1', 'follow-ups', 'support', 'week', 'standup'],
  );
});

test('generated duplicates and reserved identifiers cannot displace onboarding or break five slots', () => {
  const duplicate = generated({ id: 'other' });
  const collision = generated({ id: 'follow-ups' });
  const crossed = generated({ label: fallbackRecommendations[0].label, action: fallbackRecommendations[1].action });
  const result = combineRecommendations(complete, [generated(), duplicate, collision, crossed]);
  assert.equal(result.items.length, 5);
  assert.equal(result.items.filter(item => item.id.startsWith('generated')).length, 1);
  assert.ok(result.items.every(item => !Object.hasOwn(item, 'sources')));
  assert.throws(() => combineRecommendations(complete, [generated({ kind: 'onboarding' })]));
  assert.throws(() =>
    combineRecommendations(complete, [generated({ action: { kind: 'open', destination: 'members' } })]),
  );
});

test('Google read capabilities do not imply access to every Google product', () => {
  const rules = recommend({ ...complete, gmail: false, googleCalendar: false });
  assert.equal(
    rules.items.some(item => item.id === 'inbox' || item.id === 'meetings'),
    false,
  );
  assert.equal(
    recommend({ ...fresh, connected: true }).items.some(item => item.id === 'connect-apps'),
    false,
  );
});

test('strict generated JSON rejects tools, unknown sources, brands, provider claims, and oversized output', () => {
  assert.deepEqual(validateGeneratedRecommendations(JSON.stringify([generated()]), context()), [generated()]);
  for (const value of [
    [generated({ sources: ['table:hidden'] })],
    [generated({ brands: ['github'] })],
    [generated({ brands: ['not-a-brand'] })],
    [generated({ label: 'Read my Slack messages' })],
    [generated({ action: { kind: 'open', destination: 'files' } })],
    [generated({ tools: ['send-email'] })],
    [generated({ label: 'x'.repeat(161) })],
    [generated({ action: { kind: 'prompt', prompt: 'x'.repeat(2001) } })],
    [generated({ action: { kind: 'prompt', prompt: 'Review table:hidden.' } })],
    { items: [generated()] },
  ])
    assert.throws(() => validateGeneratedRecommendations(JSON.stringify(value), context()));
  assert.throws(() => validateGeneratedRecommendations('```json\n[]\n```', context()));
  assert.throws(() => validateGeneratedRecommendations(' '.repeat(17000), context()));
  const google = { ...entry('integration', tableId), provider: 'google', capabilities: ['gmail.read'] };
  const gmailContext = context([google], { ...fresh, google: true, gmail: true, googleCalendar: false });
  assert.throws(() =>
    validateGeneratedRecommendations(
      JSON.stringify([generated({ label: 'Read Google Calendar', sources: [google.key] })]),
      gmailContext,
    ),
  );
});

test('fingerprint ignores revision-only churn and input order, not readable content or capabilities', () => {
  const first = context([
    entry(),
    { ...entry('integration', tableId), provider: 'mcp', capabilities: ['read', 'list'] },
  ]);
  const reordered = {
    signals: { ...fresh },
    entries: [...first.entries]
      .reverse()
      .map(item => ({ ...item, revision: '999', capabilities: [...item.capabilities].reverse() })),
    policy: recommendationPolicy,
  };
  assert.equal(recommendationContextFingerprint(first), recommendationContextFingerprint(reordered));
  for (const change of [
    { ...first, policy: 'next-policy' },
    { ...first, signals: complete },
    { ...first, entries: [{ ...entry(), content: 'Use long checklists.' }] },
    { ...first, entries: [{ ...entry(), digest: 'changed-content-outside-excerpt' }] },
    { ...first, entries: [first.entries[0]] },
  ])
    assert.notEqual(recommendationContextFingerprint(first), recommendationContextFingerprint(change));
});

const saved = (overrides = {}) => ({
  refresh_generation: '3',
  status: 'ready',
  snapshot_generation: '3',
  policy: recommendationPolicy,
  onboarding: false,
  items: fallbackRecommendations,
  sources: [],
  ...overrides,
});
const readTx = (rows = [], version = 30) => {
  const calls = [];
  return {
    commonVersion: version,
    schema: 'ws_test',
    calls,
    client: {
      query: async (sql, parameters) => {
        calls.push({ sql, parameters });
        assert.deepEqual(parameters, [memberId]);
        const tables = [...sql.matchAll(/"tf_[a-z_]+"/g)].map(match => match[0]);
        assert.deepEqual([...new Set(tables)].sort(), ['"tf_recommendation_refresh"', '"tf_recommendation_snapshots"']);
        assert.match(sql, /^SELECT/);
        return { rows };
      },
    },
  };
};

test('saved reads use only snapshot/refresh state; legacy and pre-migration reads are generic', async () => {
  const old = readTx([], 0);
  assert.equal((await readSavedRecommendations(old, memberId)).status, 'unavailable');
  assert.equal(old.calls.length, 0);
  for (const status of ['pending', 'running', 'failed', 'budget-paused', 'unavailable']) {
    const tx = readTx([saved({ status, refresh_generation: '4' })]);
    const list = await readSavedRecommendations(tx, memberId);
    assert.equal(list.status, status);
    assert.equal(list.version, 4);
    assert.deepEqual(list.items, fallbackRecommendations);
    assert.equal(tx.calls.length, 1);
  }
  const legacy = await readSavedRecommendations(
    readTx([saved({ policy: 'legacy', items: ['old model output'] })]),
    memberId,
  );
  assert.equal(legacy.status, 'unavailable');
  assert.deepEqual(legacy.items, fallbackRecommendations);
  assert.equal((await readSavedRecommendations(readTx(), memberId)).status, 'unavailable');
});

test('saved row decoding rejects corrupt items, ordering, sources and unsafe PostgreSQL integers', async () => {
  for (const overrides of [
    { items: [] },
    { items: [fallbackRecommendations[0]] },
    { sources: [{}] },
    { status: 'invented' },
    { snapshot_generation: '9007199254740992' },
    { refresh_generation: '-1' },
    { refresh_generation: '1.5' },
    { onboarding: true },
    { items: [...fallbackRecommendations.slice(0, 4), fallbackRecommendations[0]] },
    { items: [...fallbackRecommendations.slice(0, 4), recommend(fresh).items[0]], onboarding: true },
  ])
    await assert.rejects(() => readSavedRecommendations(readTx([saved(overrides)]), memberId));
  assert.equal((await readSavedRecommendations(readTx([saved({ refresh_generation: 7n })]), memberId)).version, 7);
});

test('bounded context keeps own memory, denies an unreadable table, and never reads provider feeds', async () => {
  let revision = 1;
  const queries = [];
  const tx = {
    schema: 'ws_test',
    workspaceId: '10000000-0000-4000-8000-000000000004',
    commonVersion: 30,
    client: {
      query: async (sql, values = []) => {
        queries.push(sql);
        if (sql.includes('tf_authorization_lock')) return { rows: [{ id: 1 }], rowCount: 1 };
        if (sql.includes('SELECT id, user_id, role FROM'))
          return { rows: [{ id: memberId, user_id: userId, role: 'member' }], rowCount: 1 };
        if (sql.includes('SELECT content,revision')) {
          assert.deepEqual(values, [memberId]);
          return { rows: [{ content: 'Use short checklists.', revision }], rowCount: 1 };
        }
        if (sql.includes('to_regclass')) return { rows: [{ installed: true }], rowCount: 1 };
        if (sql.includes('generation.table_id::text')) {
          assert.match(sql, /g\.asset_id = generation\.table_id/);
          assert.match(sql, /pg\.asset_id = generation\.table_id/);
          assert.doesNotMatch(sql, /\bg\.table_id\b/);
          return {
            rows: [
              {
                id: tableId,
                label: 'Hidden payroll',
                revision: 'r1',
                content: 'salary',
                digest: 'hidden',
                physical_table: 'hidden_payroll',
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('SELECT EXISTS')) return { rows: [{ found: false }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    },
  };
  const actor = { kind: 'human', membershipId: memberId, userId };
  const first = await collectRecommendationContext(tx, actor);
  revision++;
  const second = await collectRecommendationContext(tx, actor);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.notEqual(
    first.sources.find(source => source.kind === 'memory').revision,
    second.sources.find(source => source.kind === 'memory').revision,
  );
  assert.equal(first.signals.table, null);
  assert.equal(JSON.stringify(first).includes('Hidden payroll'), false);
  assert.equal(first.context.entries.find(source => source.kind === 'memory').content, 'Use short checklists.');
  assert.equal(
    queries.some(sql => /FROM .*"hidden_payroll"/.test(sql)),
    false,
  );
  assert.equal(
    queries.some(sql => /tf_conversation_messages|tf_slack_events|tf_github_reads/.test(sql)),
    false,
  );
  assert.ok(
    queries
      .filter(sql => /FROM .*tf_(?:google_integrations|github_accounts|projects|files)/.test(sql))
      .every(sql => sql.includes('LIMIT')),
  );
});
