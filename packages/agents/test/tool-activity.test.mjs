import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameworkCallSchema } from '../src/tools.ts';
import { googleOperationCatalog } from '../../google-workspace/src/operation-contracts.ts';
import { githubReadSchema, githubDownloadSchema } from '../../access/src/github-read.ts';
import { githubWriteSchema } from '../../github/src/batch-contracts.ts';
import { providerOperationSchema } from '../../atlassian/src/operation-browser-contracts.ts';
import {
  toolActivityLabels,
  toolPresentation,
  githubOperationLabel,
  toolOutcomeStatus,
} from '../../conversations/src/tool-activity.ts';

test('every registered tool and provider operation has an activity label', () => {
  assert.deepEqual(
    Object.keys(toolActivityLabels).sort(),
    frameworkCallSchema.options.map(option => option.shape.tool.value).sort(),
  );
  for (const schema of [githubReadSchema, githubWriteSchema])
    for (const option of schema.options)
      for (const kind of option.shape.kind.options ?? option.shape.kind.values)
        assert.ok(githubOperationLabel(kind), kind);
  for (const kind of githubDownloadSchema.shape.kind.options) assert.ok(githubOperationLabel(kind), kind);
  for (const option of providerOperationSchema.options)
    for (const kind of option.shape.kind.options ?? option.shape.kind.values) {
      const value = toolPresentation('atlassian.read', { tool: 'atlassian.read', operation: { kind } });
      assert.ok(value.brand, kind);
      assert.notEqual(value.label, toolActivityLabels['atlassian.read'], kind);
    }
  assert.ok(googleOperationCatalog.length > 50);
});

test('labels and brands use operation identity, never private arguments or model prose', () => {
  assert.deepEqual(
    toolPresentation('github.personal.read', {
      tool: 'github.personal.read',
      operation: { kind: 'issue.search', query: 'secret' },
    }),
    { label: 'Search GitHub issues', brand: 'github' },
  );
  assert.deepEqual(
    toolPresentation('atlassian.read', { tool: 'atlassian.read', operation: { kind: 'card.search', query: 'secret' } }),
    { label: 'Search Trello cards', brand: 'trello' },
  );
  assert.deepEqual(
    toolPresentation('google.read', { tool: 'google.read', operation: { kind: 'gmail.messages.list', q: 'secret' } }),
    { label: 'Reading your Gmail data', brand: 'gmail' },
  );
  assert.deepEqual(toolPresentation('atlassian.read', undefined, 'Search Confluence pages'), {
    label: 'Search Confluence pages',
    brand: 'confluence',
  });
  assert.equal(
    toolPresentation('github.personal.read', undefined, 'Secret repository name').label,
    'Reading GitHub information',
  );
  assert.equal(toolPresentation('tables.import.file').label, 'Preparing a file for import');
  assert.equal(
    toolPresentation('github.personal.propose', { tool: 'github.personal.propose', actions: [{ kind: 'issue.close' }] })
      .label,
    'Preparing: Close GitHub issue',
  );
});

test('provider failures cannot appear as successful tool activity', () => {
  assert.equal(toolOutcomeStatus({ provider: 'google-workspace', error: 'reconnect-required' }), 'failed');
  assert.equal(toolOutcomeStatus({ code: 'access-denied' }), 'blocked');
  assert.equal(toolOutcomeStatus({ data: { status: 'outcome-unknown' } }), 'unknown');
  assert.equal(toolOutcomeStatus({ state: 'unresolved' }), 'unknown');
  assert.equal(toolOutcomeStatus({ status: 'succeeded', error: null }), 'completed');
  assert.equal(toolOutcomeStatus({ actions: [{ status: 'succeeded' }, { status: 'unknown' }] }), 'unknown');
  assert.equal(toolOutcomeStatus({ data: { messages: [] } }), 'completed');
});
