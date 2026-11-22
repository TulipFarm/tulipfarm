import assert from 'node:assert/strict';
import { test } from 'node:test';
import { objectWorkspace } from '../dist/resource-billing.js';

test('stored objects are attributed to the workspace in their key', () => {
  const ws = '6f1c0a52-35f4-4c4e-9a8e-0d3f1b2c4d5e';
  assert.equal(objectWorkspace(`${ws}/files/report.pdf`), ws);
  assert.equal(objectWorkspace(`workspaces/${ws}/soul.md`), ws);
  assert.equal(objectWorkspace(`apps/${ws}/bundle.js`), ws);
  assert.equal(objectWorkspace('releases/abc/index.html'), undefined);
  assert.equal(objectWorkspace('workspaces/not-a-workspace/x'), undefined);
  assert.equal(objectWorkspace(`other/${ws}/x`), undefined);
});
