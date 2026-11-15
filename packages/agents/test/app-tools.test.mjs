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

test('only an app chat is offered the tools for its kind of app, without searching for them', () => {
  assert.deepEqual(offered(nativeChatTools(undefined, false, new Set(), false, false, 'public')), appTools);
  assert.deepEqual(offered(nativeChatTools(undefined, false, new Set(), false, false, 'private')), [
    'apps_page_check',
    'apps_page_read',
    'apps_page_replace',
  ]);
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

test('a page replace needs a page ID and the revision it read', () => {
  const replace = call => chatCallSchema.safeParse({ tool: 'apps.page.replace', ...call }).success;
  assert.equal(replace({ page: { id: 'home', title: 'Home' }, expectedRevision: 3 }), true);
  assert.equal(replace({ page: { title: 'Home' }, expectedRevision: 3 }), false);
  assert.equal(replace({ page: { id: 'home' } }), false);
});
