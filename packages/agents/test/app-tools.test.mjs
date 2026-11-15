import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAppRecipe } from '@tulipfarm/apps';
import { appRecipeExamples } from '../src/app-tools.ts';
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

test('the file write tool shows the model one app.json that builds for each kind of app', () => {
  const write = nativeChatTools(undefined, false, new Set(), false, false, 'public').tools.find(
    tool => tool.name === 'apps_files_write',
  );
  assert.ok(
    write.description.endsWith(
      'An optional app.json at the app root says how to build it; without one the files are served as they are. It takes one of these shapes and no other keys; install is optional. ' +
        'Serve a folder as it is: {"kind":"copy","root":"site"}. ' +
        'Run a build, then serve its output folder: {"kind":"command","runtime":"node22","install":"npm install","command":"npm run build","output":"dist"}. ' +
        'Run a Node server that listens on serve.port: {"kind":"server","runtime":"node22","install":"npm install","serve":{"port":8080,"start":"node server.js"}}.',
    ),
    write.description,
  );
  assert.deepEqual(
    appRecipeExamples.map(([, recipe]) => readAppRecipe(JSON.stringify(recipe))),
    appRecipeExamples.map(([, recipe]) => ({ ok: true, recipe })),
  );
});
