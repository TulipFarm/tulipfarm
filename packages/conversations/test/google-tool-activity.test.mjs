import assert from 'node:assert/strict';
import { test } from 'node:test';
import { googleToolActivity } from '../src/google-tool-activity.ts';
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
