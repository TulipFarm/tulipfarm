import assert from 'node:assert/strict';
import { test } from 'node:test';
import { googleToolActivity } from '../src/google-tool-activity.ts';
import { deniedProposalDetail, rowReviewDetail, storedToolActivity } from '../src/tool-activity-history.ts';
import { apiCallProblem, apiCallReceipt, toolPresentation } from '../src/tool-activity.ts';

test('Google activity describes the actual action without including private arguments', () => {
  assert.equal(
    googleToolActivity('google.read', {
      tool: 'google.read',
      operation: { kind: 'gmail.messages.list', q: 'from:private@example.com' },
    }),
    'Reading your Gmail data',
  );
  assert.equal(
    googleToolActivity('google.read', {
      tool: 'google.read',
      operation: { kind: 'gmail.messages.get', messageId: 'private-id' },
    }),
    'Reading your Gmail data',
  );
  assert.equal(
    googleToolActivity('google.read', {
      tool: 'google.read',
      operation: { kind: 'drive.files.list', q: "name = 'Private budget'" },
    }),
    'Reading your Google Drive data',
  );
  assert.equal(
    googleToolActivity('google.propose', {
      tool: 'google.propose',
      operation: { kind: 'gmail.messages.trash', messageId: 'private-id' },
    }),
    'Preparing: Move a Gmail message to trash',
  );
  assert.equal(
    googleToolActivity('google.read', { tool: 'google.read', operation: { kind: 'private-label' } }),
    'Reading your Google data',
  );
  assert.equal(
    googleToolActivity('google.propose', {
      tool: 'google.propose',
      document: { name: 'Private plan', format: 'xlsx', content: '{}' },
    }),
    'Preparing: Create a Google Sheet',
  );
  assert.equal(
    googleToolActivity('google.propose', null, 'Preparing: Create a Google Doc'),
    'Preparing: Create a Google Doc',
  );
  assert.equal(
    googleToolActivity('tables.definitions', { tool: 'google.read', operation: { kind: 'gmail.messages.list' } }),
    null,
  );
  assert.equal(googleToolActivity('google.read', null), 'Reading your Google data');
  assert.equal(googleToolActivity('google.read', null, 'Reading a Gmail message'), 'Reading your Gmail data');
  assert.equal(googleToolActivity('google.read', null, 'Reading private email from Alice'), 'Reading your Google data');
});

test('every Google service has a read label even when operation arguments are incomplete', () => {
  for (const [kind, label] of [
    ['calendar.events.list', 'Reading your Google Calendar data'],
    ['gmail.messages.get', 'Reading your Gmail data'],
    ['drive.files.get', 'Reading your Google Drive data'],
    ['sheets.values.get', 'Reading your Google Sheets data'],
    ['docs.documents.get', 'Reading your Google Docs data'],
    ['slides.presentations.get', 'Reading your Google Slides data'],
  ]) {
    assert.equal(googleToolActivity('google.read', { tool: 'google.read', operation: { kind } }), label);
    assert.equal(googleToolActivity('google.read', null, label), label);
  }
});

test('API call activity names the method, host and path but never the query', () => {
  assert.equal(
    toolPresentation('api.request', {
      tool: 'api.request',
      method: 'GET',
      url: 'https://api.example.com/v1/events?api_key=never-shown',
    }).label,
    'GET api.example.com/v1/events',
  );
  assert.equal(toolPresentation('api.request').label, 'Calling an API');
});

test('API call receipts keep only the HTTP status or error code, and every failure has a short message', () => {
  const sent = { status: 'sent', response: { status: 404, headers: { 'x-key': 'never-shown' } } };
  assert.deepEqual(apiCallReceipt('api.request', { result: sent, sources: [] }), { httpStatus: 404 });
  assert.deepEqual(
    apiCallReceipt('api.request', { result: { status: 'failed', code: 'approval-unavailable', message: 'x' } }),
    { error: 'approval-unavailable' },
  );
  assert.equal(apiCallReceipt('web.fetch', { result: sent }), null);
  assert.equal(apiCallReceipt('api.request', { result: { error: 'plan-only' } }), null);
  assert.deepEqual(apiCallReceipt('api.request', { result: sent, sources: [] }, true), {
    httpStatus: 404,
    review: true,
  });
  assert.deepEqual(apiCallReceipt('api.request', { provider: 'api-call', kind: 'waiting' }, true), { review: true });
  assert.equal(apiCallProblem('approval-unavailable'), 'Changes need your approval, which isn’t available here.');
  assert.equal(apiCallProblem('rejected'), 'You chose not to send this request.');
  assert.equal(apiCallProblem('secret-reflected'), 'The response repeated the secret, so it was hidden.');
  assert.equal(apiCallProblem(undefined), 'The API call failed.');
  assert.equal(apiCallProblem('toString'), 'The API call failed.');
});

test('a denied table proposal names the permissions for the kind of change it asked for', () => {
  const denied = plans => deniedProposalDetail({ tool: 'tables.propose', input: JSON.stringify({ plans }) });
  assert.match(String(denied([{ kind: 'schema', expectedRevision: null }])), /needs Create tables for its owning team/);
  for (const plans of [[{ kind: 'schema', expectedRevision: 'r1' }], [{ kind: 'archive' }, { kind: 'restore' }]])
    assert.match(String(denied(plans)), /needs Read rows and Manage schema on the table/);
  for (const plans of [[{ kind: 'records' }], [{ kind: 'import' }, { kind: 'records' }]])
    assert.match(String(denied(plans)), /needs Read rows plus Create rows, Update rows or Delete rows/);
  // Mixed or unreadable requests fall back to the general text the web app shows.
  assert.equal(denied([{ kind: 'schema', expectedRevision: null }, { kind: 'records' }]), undefined);
  assert.equal(denied([]), undefined);
  assert.equal(deniedProposalDetail({ tool: 'tables.propose', input: 'not json' }), undefined);
  assert.equal(deniedProposalDetail(undefined), undefined);
});

test('a denied table proposal never tells a workspace admin to ask a workspace admin', async () => {
  const call = { tool: 'tables.propose', input: JSON.stringify({ plans: [{ kind: 'import' }] }) };
  const row = { id: crypto.randomUUID(), tool: 'tables.propose', status: 'blocked', call };
  const member = await storedToolActivity(undefined, row);
  assert.match(String(member.detail), /Ask a workspace admin/);
  const admin = await storedToolActivity(undefined, row, { admin: true });
  assert.equal(admin.status, 'blocked');
  assert.doesNotMatch(String(admin.detail), /ask a workspace admin/i);
  assert.match(String(admin.detail), /already have every table permission/);
});

test('an archive blocked by an active workflow keeps the workflows it named so the step can link them', async () => {
  const workflow = { id: '7f0c7a52-2f4b-4c39-9d1e-6a1f6b0c2d3e', name: 'QA retest 6 flow' };
  const tx = { client: { query: () => assert.fail('no query needed') } };
  const activity = output =>
    storedToolActivity(tx, { id: crypto.randomUUID(), tool: 'tables.propose', status: 'completed', output });
  assert.deepEqual(
    await activity({ result: { error: 'workflow-active', workflows: [{ ...workflow, url: '/acme/x' }] } }),
    {
      status: 'completed',
      detail: 'Not archived: an active workflow uses this table.',
      workflows: [workflow],
    },
  );
  assert.deepEqual(await activity({ result: { error: 'workflow-active' } }), {
    status: 'completed',
    detail: 'Not archived: an active workflow uses this table.',
  });
  assert.equal((await activity({ result: { error: 'table-linked', workflows: [workflow] } })).workflows, undefined);
});

test('a chat row write held for approval names the rule in Tool activity', () => {
  const batch = { result: { error: 'review-required', reason: 'too-many-rows', table: 'Contacts' }, sources: [] };
  assert.match(
    rowReviewDetail('rows.create.batch', batch),
    /^Not written\. .*more than 5 rows.*approval on a chat card/,
  );
  assert.match(
    rowReviewDetail('rows.create', {
      draftId: 'd',
      status: 'review-required',
      reason: 'table-not-named',
      table: 'Orders',
    }),
    /^Not written yet\. .*didn’t name Orders.*approval/,
  );
  assert.match(rowReviewDetail('rows.create.batch', { error: 'review-required' }), /outside content/);
  assert.match(rowReviewDetail('rows.update', { error: 'review-unavailable' }), /can’t change rows/);
  assert.match(
    rowReviewDetail('rows.create', { error: 'approval-pending', table: 'Contacts' }),
    /to Contacts .*still waiting for your approval/,
  );
  assert.match(rowReviewDetail('rows.create', { error: 'batch-required' }), /^Not written: several new rows/);
  assert.match(
    rowReviewDetail('rows.create.batch', { draftId: 'd', reason: 'too-many-rows', alreadyWritten: 3 }),
    /^Not written yet\. This reply already added 3 rows directly, and those stay\. .*more than 5 rows/,
  );
  assert.equal(rowReviewDetail('rows.create', { record: { id: 'r' } }), undefined);
  assert.equal(rowReviewDetail('rows.create', { draftId: 'd', status: 'review-required' }), undefined);
  assert.equal(rowReviewDetail('tables.propose', { error: 'review-required', reason: 'too-many-rows' }), undefined);
});
