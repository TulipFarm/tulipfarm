import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedCompletion, creationRequested, preloadTools } from '../src/decisions.ts';

const workspaceId = '00000000-0000-4000-8000-000000000001';

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
