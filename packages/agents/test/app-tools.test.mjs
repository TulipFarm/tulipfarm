import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeChatTools } from '../src/native-tools.ts';
import { chatCallSchema } from '../src/tools.ts';

const appTools = [
  'apps_files_delete',
  'apps_files_list',
  'apps_files_read',
  'apps_files_write',
  'apps_preview_build',
  'apps_status',
];
const offered = catalog =>
  catalog.tools
    .map(tool => tool.name)
    .filter(name => name.startsWith('apps_'))
    .sort();

test('only an app chat is offered the app tools, without searching for them', () => {
  assert.deepEqual(offered(nativeChatTools(undefined, false, new Set(), false, false, true)), appTools);
  assert.deepEqual(offered(nativeChatTools(undefined, false, new Set())), []);
  assert.deepEqual(offered(nativeChatTools(undefined, true, undefined, true, true)), []);
});

test('app file calls accept only paths inside the app', () => {
  const write = path => chatCallSchema.safeParse({ tool: 'apps.files.write', path, content: '<h1>Hi</h1>' }).success;
  assert.equal(write('src/index.html'), true);
  assert.equal(write('../secrets'), false);
  assert.equal(write('/etc/passwd'), false);
  assert.deepEqual(chatCallSchema.parse({ tool: 'apps.files.read', path: 'index.html' }), {
    tool: 'apps.files.read',
    path: 'index.html',
    offset: 0,
    limit: 32000,
  });
});
