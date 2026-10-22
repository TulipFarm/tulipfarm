import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowResults } from '../src/features/chat/workflow-results.ts';
import type { ConversationMessage } from '../src/features/chat/conversation-api.ts';

const reference = { workflowId: 'workflow-a', revision: 'revision-a', name: 'PR summaries' };
const tool = (id: string, workflows = [reference]): ConversationMessage['tools'][number] => ({
  id,
  tool: 'workflows.read',
  status: 'completed',
  workflows,
});

test('identical workflow results collapse across tool calls within a message', () => {
  assert.deepEqual(workflowResults([tool('list'), tool('read')]), [{ ...reference, label: reference.name }]);
});

test('different revisions and same-named workflows remain separate and named', () => {
  const results = workflowResults([
    tool('read', [reference, { ...reference, revision: 'revision-b' }, { ...reference, workflowId: 'workflow-b' }]),
  ]);
  assert.equal(results.length, 3);
  assert.equal(new Set(results.map(result => result.label)).size, 3);
  assert.deepEqual(
    results.map(({ workflowId, revision }) => [workflowId, revision]),
    [
      ['workflow-a', 'revision-a'],
      ['workflow-a', 'revision-b'],
      ['workflow-b', 'revision-a'],
    ],
  );
});

test('non-completed calls do not claim a workflow result', () => {
  assert.deepEqual(workflowResults([{ ...tool('failed'), status: 'failed' }]), []);
  assert.deepEqual(workflowResults([]), []);
});
