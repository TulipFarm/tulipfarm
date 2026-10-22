import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import type * as Activity from '../src/features/chat/result-activity.ts';
import type * as Google from '../src/features/google/action-state.ts';
import type { GoogleProposal } from '../src/lib/google-workspace.ts';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
after(() => server.close());
const { resultActivityApps, activityActionState } = (await server.ssrLoadModule(
  '/src/features/chat/result-activity.ts',
)) as typeof Activity;
const { googleActionState, googleDestination, googleReceiptFile } = (await server.ssrLoadModule(
  '/src/features/google/action-state.ts',
)) as typeof Google;

test('connector actions keep every explicit status and merge only normalized brands', () => {
  const statuses = ['queued', 'waiting', 'running', 'completed', 'blocked', 'failed', 'cancelled', 'unknown'] as const;
  const items = statuses.map((status, index) => ({
    id: String(index),
    tool: 'atlassian.read',
    status,
    presentation: { label: `Action ${index}`, brand: 'jira' as const },
  }));
  const apps = resultActivityApps(items);
  assert.equal(apps.length, 1);
  assert.equal(apps[0]?.name, 'Jira');
  assert.deepEqual(
    apps[0]?.actions.map(action => action.state),
    ['pending', 'pending', 'running', 'completed', 'blocked', 'failed', 'cancelled', 'unknown'],
  );
  assert.equal(activityActionState('waiting'), 'pending');
  assert.deepEqual(
    resultActivityApps([
      { id: '1', tool: 'tables.list', status: 'completed', presentation: { label: 'Send in Gmail', brand: null } },
    ]),
    [],
    'prose does not invent app usage',
  );
  assert.equal(
    resultActivityApps([
      { id: '1', tool: 'mcp.call', status: 'unknown', presentation: { label: 'Run a connected tool', brand: null } },
    ])[0]?.brand,
    null,
  );
});

const operations: GoogleProposal['operation'][] = [
  { kind: 'docs.documents.create', title: 'Brief' },
  { kind: 'sheets.spreadsheets.create', title: 'Budget' },
  { kind: 'slides.presentations.create', title: 'Pitch' },
  { kind: 'drive.files.create', file: { name: 'Folder', mimeType: 'application/vnd.google-apps.folder' } },
  { kind: 'gmail.messages.send', message: { to: ['reader@example.test'], subject: 'Update', body: 'Ready' } },
  {
    kind: 'calendar.events.create',
    calendarId: 'primary',
    event: { summary: 'Review', start: { date: '2027-01-01' }, end: { date: '2027-01-02' } },
  },
];
test('all Google families distinguish approval, confirmed success and uncertain execution', () => {
  for (const [index, operation] of operations.entries()) {
    const proposal: GoogleProposal = {
      id: '11111111-1111-4111-8111-111111111111',
      operation,
      digest: 'f'.repeat(64),
      expiresAt: '2099-01-01T00:00:00Z',
      integration: {
        integrationId: '22222222-2222-4222-8222-222222222222',
        accountId: 'fixture',
        generation: 1,
        scopes: [],
        requiredScopes: [],
      },
      decision: null,
      receipt: null,
    };
    assert.equal(
      googleDestination(operation),
      ['Google Docs', 'Google Sheets', 'Google Slides', 'Google Drive', 'Gmail', 'Google Calendar'][index],
    );
    assert.equal(googleActionState(proposal).kind, 'review');
    proposal.decision = 'approve';
    assert.equal(googleActionState(proposal).kind, 'approved');
    assert.equal(googleReceiptFile(proposal), null);
    proposal.receipt = { status: 'succeeded', result: { untrusted: true, data: { id: 'saved-file' } }, error: null };
    assert.equal(googleActionState(proposal).kind, 'succeeded');
    assert.equal(
      googleActionState(proposal, { kind: 'uncertain', action: 'execute' }).kind,
      'unknown',
      'uncertainty takes precedence over stale receipts',
    );
    proposal.receipt = { status: 'outcome-unknown', result: null, error: 'provider-outcome-unknown' };
    assert.equal(googleActionState(proposal).kind, 'unknown');
    assert.equal(googleReceiptFile(proposal), null);
    proposal.receipt = { status: 'failed', result: null, error: 'provider-request-failed' };
    assert.equal(googleActionState(proposal).kind, 'failed');
    proposal.receipt = null;
    proposal.decision = 'reject';
    assert.equal(googleActionState(proposal).kind, 'rejected');
  }
});
