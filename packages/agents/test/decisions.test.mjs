import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptedCompletion,
  calendarTextFastPath,
  classifyDriftAgreement,
  classifyTurnComplexity,
  confidenceBucket,
  containsSecretPattern,
  creationRequested,
  heartbeatMatches,
  preloadSkills,
  preloadTools,
  recordDecisionDrift,
  recordHumanOverride,
  rowReviewIntent,
  sampleDecisionDrift,
  scrubDecisionText,
  taskCompletionStatus,
  worthLearning,
} from '../src/decisions.ts';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const jevResponse = answers => new Response(JSON.stringify({ answers }), { status: 200 });

function jev(t, answer) {
  t.mock.method(process.stdout, 'write', () => true);
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify({ answers: answer(body) }));
  });
  process.env.TYPESAFE_API_KEY = 'test-key';
  t.after(() => delete process.env.TYPESAFE_API_KEY);
  return bodies;
}

const sizes = {
  deferred: [
    { name: 'github_issue_read', bytes: 2000 },
    { name: 'skills_draft', bytes: 4000 },
    { name: 'skills_list', bytes: 1000 },
    { name: 'workflows_draft', bytes: 40_000 },
  ],
  coreBytes: 40_000,
};

test('preloadTools offers a group when its probability outweighs its schema cost, with the groups it depends on', async t => {
  const bodies = jev(t, body =>
    Object.fromEntries(
      Object.keys(body.questions).map(id => [
        id,
        { noul: { 'github-investigation': 0.9, 'skills-manage': 0.6, workflows: 0.4 }[id] ?? 0.01 },
      ]),
    ),
  );
  const tools = await preloadTools({ request: 'Read issue 4 and write a skill for it', earlier: [], ...sizes });
  assert.deepEqual(tools.sort(), ['github_issue_read', 'skills_draft', 'skills_list']);
  assert.deepEqual(Object.keys(bodies[0].questions).sort(), [
    'github-investigation',
    'skills-manage',
    'skills-use',
    'workflows',
  ]);
});

test('preloadTools offers nothing without a key or when Jev fails', async t => {
  assert.deepEqual(await preloadTools({ request: 'Read issue 4', earlier: [], ...sizes }), []);
  jev(t, new Error('down'));
  assert.deepEqual(await preloadTools({ request: 'Read issue 4', earlier: [], ...sizes }), []);
});

test('acceptedCompletion only accepts a confident stopping status without a requested row review', async t => {
  let status = { choice: 'completed', confidence: 0.95 };
  let review = 0.1;
  jev(t, () => ({ status, rowReviewRequested: { noul: review } }));
  const evidence = JSON.stringify({ candidate: '4', history: [] });
  assert.equal(await acceptedCompletion(evidence), 'completed');
  status = { choice: 'completed', confidence: 0.8 };
  assert.equal(await acceptedCompletion(evidence), undefined);
  status = { choice: 'continue', confidence: 0.99 };
  assert.equal(await acceptedCompletion(evidence), undefined);
  status = { choice: 'waiting', confidence: 0.95 };
  review = 0.7;
  assert.equal(await acceptedCompletion(evidence), undefined);
});

test('creationRequested saves only at high confidence and leaves the decision to the caller when Jev fails', async t => {
  let saveNow = 0.75;
  jev(t, () => ({ saveNow: { noul: saveNow } }));
  assert.equal(await creationRequested(workspaceId, 'Create a Leads table', 'table'), true);
  saveNow = 0.6;
  assert.equal(await creationRequested(workspaceId, 'Create a Leads table and turn it on', 'table'), false);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }));
  assert.equal(await creationRequested(workspaceId, 'Create a Leads table', 'table'), undefined);
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(await creationRequested(workspaceId, 'Create a Leads table', 'table'), undefined);
});

test('scrubDecisionText redacts credentials including non-word endings before outbound Jev calls', async t => {
  const token = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
  const bearer = 'Bearer dXNlcjpwYXNzMTIzNDU2==';
  assert.equal(containsSecretPattern(`use ${token} here`), true);
  assert.equal(scrubDecisionText(`use ${token} here`), 'use [REDACTED] here');
  assert.equal(scrubDecisionText(`auth ${bearer}`), 'auth [REDACTED]');
  const bodies = jev(t, () => ({ hasDurableSignal: { noul: 0.8 } }));
  await worthLearning(workspaceId, 'memory', `My key is ${token} and ${bearer}`);
  assert.equal(bodies[0].state.content, 'My key is [REDACTED] and [REDACTED]');
});

test('worthLearning skips confident empty chunks and fails open on errors or missing key', async t => {
  let score = 0.1;
  jev(t, () => ({ hasDurableSignal: { noul: score } }));
  assert.equal(await worthLearning(workspaceId, 'memory', 'Thanks!'), false);
  score = 0.3;
  assert.equal(await worthLearning(workspaceId, 'knowledge', 'Our fiscal year starts in April'), true);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  assert.equal(await worthLearning(workspaceId, 'agent-lesson', '[]'), true);
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(await worthLearning(workspaceId, 'memory', 'Thanks!'), true);
});

test('heartbeatMatches skips confident non-matches and fails open on error', async t => {
  let score = 0.05;
  jev(t, () => ({ matches: { noul: score } }));
  assert.equal(
    await heartbeatMatches(workspaceId, 'Summarize customer escalations', {
      from: 'news@example.com',
      subject: 'Weekly newsletter',
    }),
    false,
  );
  score = 0.4;
  assert.equal(
    await heartbeatMatches(workspaceId, 'Summarize customer escalations', {
      from: 'ceo@customer.com',
      subject: 'Urgent outage',
    }),
    true,
  );
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }));
  assert.equal(await heartbeatMatches(workspaceId, 'Summarize customer escalations', { subject: 'Ping' }), true);
});

test('drift helpers classify agreement, bucket confidence, and sample asynchronously', async t => {
  assert.equal(confidenceBucket(0.1), '0-25');
  assert.equal(confidenceBucket(0.35), '25-50');
  assert.equal(confidenceBucket(0.6), '50-75');
  assert.equal(confidenceBucket(0.85), '75-90');
  assert.equal(confidenceBucket(0.95), '90-100');
  assert.equal(classifyDriftAgreement(true, true), 'agree');
  assert.equal(classifyDriftAgreement(true, false), 'false-accept');
  assert.equal(classifyDriftAgreement(false, true), 'false-reject');

  const lines = [];
  const write = t.mock.method(process.stdout, 'write', line => {
    const text = String(line);
    if (text.startsWith('{')) lines.push(text);
    return true;
  });
  process.env.TYPESAFE_API_KEY = 'test-key';
  t.after(() => delete process.env.TYPESAFE_API_KEY);

  assert.equal(
    recordDecisionDrift({ kind: 'creation-review', decision: true, reference: false, confidence: 0.8 }),
    'false-accept',
  );
  recordHumanOverride({ kind: 'creation-review', confidence: 0.92 });
  sampleDecisionDrift(workspaceId, {
    kind: 'learning-gate',
    decision: false,
    confidence: 0.91,
    sampleRate: 1,
    random: () => 0,
    reference: async () => false,
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  write.mock.restore();
  const events = lines.map(line => JSON.parse(line));
  assert.equal(
    events.some(entry => entry.operation === 'decisions.drift-audit' && entry['decision.agreement'] === 'false-accept'),
    true,
  );
  assert.equal(
    events.some(
      entry => entry.operation === 'decisions.drift-override' && entry['decision.kind'] === 'creation-review',
    ),
    true,
  );
  assert.equal(
    events.some(
      entry =>
        entry.operation === 'decisions.drift-audit' &&
        entry['decision.kind'] === 'learning-gate' &&
        entry['decision.agreement'] === 'agree',
    ),
    true,
  );
});

test('preloadSkills ranks matching skills above 0.6 and caps at 3', async t => {
  process.env.TYPESAFE_API_KEY = 'test-key';
  t.after(() => delete process.env.TYPESAFE_API_KEY);
  t.mock.method(globalThis, 'fetch', async () =>
    jevResponse({
      s0: { noul: 0.91 },
      s1: { noul: 0.22 },
      s2: { noul: 0.78 },
      s3: { noul: 0.65 },
      s4: { noul: 0.84 },
    }),
  );
  const picked = await preloadSkills({
    request: 'Prepare our quarterly investor update',
    skills: [
      { id: 'sk-0', name: 'Investor update', description: 'Draft investor emails' },
      { id: 'sk-1', name: 'Bug triage', description: 'Triage GitHub issues' },
      { id: 'sk-2', name: 'Financial summary', description: 'Summarize revenue' },
      { id: 'sk-3', name: 'Board deck', description: 'Outline board slides' },
      { id: 'sk-4', name: 'Quarterly metrics', description: 'Compute quarterly KPIs' },
    ],
  });
  assert.deepEqual(picked, ['sk-0', 'sk-4', 'sk-2']);
});

test('rowReviewIntent filters confident false positives and preserves uncertain review', async t => {
  process.env.TYPESAFE_API_KEY = 'test-key';
  t.after(() => delete process.env.TYPESAFE_API_KEY);
  let score = 0.1;
  t.mock.method(globalThis, 'fetch', async () => jevResponse({ wantsReview: { noul: score } }));
  assert.equal(await rowReviewIntent('What rows did we update yesterday?'), false);
  score = 0.28;
  assert.equal(await rowReviewIntent('Maybe check the rows later'), undefined);
  score = 0.85;
  assert.equal(await rowReviewIntent('Prepare row updates for me to review before saving'), true);
});

test('calendarTextFastPath skips full LLM only when confident both fields are unspecified', async t => {
  process.env.TYPESAFE_API_KEY = 'test-key';
  t.after(() => delete process.env.TYPESAFE_API_KEY);
  let score = 0.92;
  t.mock.method(globalThis, 'fetch', async () => jevResponse({ bothUnspecified: { noul: score } }));
  assert.equal(
    await calendarTextFastPath({ kind: 'calendar.events.create' }, [
      { role: 'user', text: 'Book 30m tomorrow at 2pm' },
    ]),
    true,
  );
  score = 0.55;
  assert.equal(
    await calendarTextFastPath({ kind: 'calendar.events.create' }, [{ role: 'user', text: 'Create "Q3 Sync"' }]),
    false,
  );
});

test('classifyTurnComplexity routes simple turns only at high confidence', async t => {
  process.env.TYPESAFE_API_KEY = 'test-key';
  t.after(() => delete process.env.TYPESAFE_API_KEY);
  let answer = { choice: 'simple', confidence: 0.91 };
  t.mock.method(globalThis, 'fetch', async () => jevResponse({ complexity: answer }));
  assert.equal(await classifyTurnComplexity(workspaceId, 'What is 12 * 12?'), 'simple');
  answer = { choice: 'simple', confidence: 0.7 };
  assert.equal(await classifyTurnComplexity(workspaceId, 'Summarize our Q3 pipeline'), 'standard');
  answer = { choice: 'complex', confidence: 0.82 };
  assert.equal(await classifyTurnComplexity(workspaceId, 'Audit all integrations and design a migration'), 'complex');
});

test('taskCompletionStatus distinguishes done, continue, and uncertain replies', async t => {
  process.env.TYPESAFE_API_KEY = 'test-key';
  t.after(() => delete process.env.TYPESAFE_API_KEY);
  let answer = { choice: 'continue', confidence: 0.88 };
  t.mock.method(globalThis, 'fetch', async () => jevResponse({ status: answer }));
  assert.equal(await taskCompletionStatus(workspaceId, 'I will now check the table and report back.'), 'continue');
  answer = { choice: 'done', confidence: 0.9 };
  assert.equal(await taskCompletionStatus(workspaceId, 'All 3 invoices are verified.'), 'done');
  answer = { choice: 'done', confidence: 0.5 };
  assert.equal(await taskCompletionStatus(workspaceId, 'Checking...'), undefined);
});

test('calendarTextFastPath falls back on long histories and new helpers fail safe on HTTP errors', async t => {
  process.env.TYPESAFE_API_KEY = 'test-key';
  t.after(() => delete process.env.TYPESAFE_API_KEY);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('server error', { status: 500 });
  });
  // More than 6 user messages must skip Jev and fall back to full check (false) without calling fetch.
  const manyMessages = Array.from({ length: 7 }, (_, i) => ({ role: 'user', text: `msg ${i}` }));
  assert.equal(await calendarTextFastPath({ kind: 'calendar.events.create' }, manyMessages), false);
  assert.equal(calls, 0);
  // HTTP 500 fails safe across all helpers.
  assert.deepEqual(await preloadSkills({ request: 'triage', skills: [{ id: 's1', name: 'Triage' }] }), []);
  assert.equal(await rowReviewIntent('update rows'), undefined);
  assert.equal(await classifyTurnComplexity(workspaceId, 'Hi'), undefined);
  assert.equal(await taskCompletionStatus(workspaceId, 'Done'), undefined);
});
