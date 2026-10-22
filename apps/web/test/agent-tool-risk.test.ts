import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { toolNameSchema } from '@tulipfarm/agents/contracts';
import { readOnlyTools } from '@tulipfarm/agents/tools';
import type * as ToolPicker from '../src/features/agents/tool-picker.tsx';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
after(() => server.close());
const { changingTools } = (await server.ssrLoadModule('/src/features/agents/tool-picker.tsx')) as typeof ToolPicker;

// The server leaves task reads out of its parallel read set, but a task read changes nothing.
const readsOutsideReadOnlySet = new Set<string>(['agents.task.read']);

test('every agent action the server does not treat as read-only is shown as changing data', () => {
  const unmarked = toolNameSchema.options.filter(
    tool => !readOnlyTools.has(tool) && !changingTools.has(tool) && !readsOutsideReadOnlySet.has(tool),
  );
  assert.deepEqual(unmarked, []);
});

test('each read exception is a real action outside both sets, so a stale entry fails', () => {
  for (const tool of readsOutsideReadOnlySet) {
    assert.ok((toolNameSchema.options as readonly string[]).includes(tool), tool);
    assert.equal(readOnlyTools.has(tool as never) || changingTools.has(tool), false, tool);
  }
});

test('no read-only agent action is shown as changing data', () => {
  assert.deepEqual(
    [...changingTools].filter(tool => readOnlyTools.has(tool)),
    [],
  );
});
