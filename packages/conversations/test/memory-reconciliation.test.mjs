import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applyFileEdits, listMemoryFiles, parseFileEdits, readMemoryFile } from '../src/memory-files.ts';
import { applyMemoryEdit } from '../src/memory-learning.ts';
import { fakeKeep } from './fake-keep.mjs';

const id = randomUUID();
const messages = [{ id, text: 'Please use emojis in your replies. I lead the Falcon launch.' }];
const transcript = `<message id="${id}" role="requester">\n${messages[0].text}\n</message>`;
const output = edits => JSON.stringify({ edits });
const memory = () => ({ client: fakeKeep().client, scope: { workspace: randomUUID(), user: randomUUID() } });

test('memory edits apply only where they fit exactly once', () => {
  const current = 'Use short replies.\n- Use emojis.\n- Greet me.';
  assert.equal(
    applyMemoryEdit(current, { kind: 'add', before: null, after: 'Use British spelling.' }),
    `${current}\nUse British spelling.`,
  );
  assert.equal(applyMemoryEdit(current, { kind: 'add', before: null, after: 'Use emojis.' }), undefined);
  assert.equal(
    applyMemoryEdit(current, { kind: 'remove', before: 'Use emojis.', after: null }),
    'Use short replies.\n- Greet me.',
  );
  assert.equal(applyMemoryEdit(current, { kind: 'change', before: 'Use', after: 'Try' }), undefined, 'ambiguous text');
  assert.equal(applyMemoryEdit(current, { kind: 'remove', before: 'missing', after: null }), undefined);
});

test('learned edits need the member’s literal words, stay in memory paths and never delete files', () => {
  const quote = 'use emojis';
  const add = { path: '/profile.md', kind: 'add', before: null, after: 'Use emojis.', messageId: id, quote };
  const parse = edits => parseFileEdits(output(edits), { kind: 'learning', maximum: 5, transcript, messages });
  assert.deepEqual(parse([add]), [{ path: '/profile.md', kind: 'add', before: null, after: 'Use emojis.' }]);
  assert.equal(parse([add, add]).length, 1, 'duplicates');
  for (const edit of [
    { ...add, quote: 'never said this' },
    { ...add, messageId: randomUUID() },
    { ...add, path: '/notes/secret.md' },
    { ...add, path: '/topics/Not A Slug.md' },
    { ...add, kind: 'delete', path: '/topics/falcon.md' },
  ])
    assert.deepEqual(parse([edit]), []);
  assert.throws(() => parse('not json'), /memory-invalid-preferences/);
  assert.throws(() => parseFileEdits('not json', { kind: 'instruction', maximum: 5 }), /memory-invalid-preferences/);
  const instruction = parseFileEdits(
    output([{ path: '/topics/falcon.md', kind: 'delete', before: null, after: null }]),
    { kind: 'instruction', maximum: 5 },
  );
  assert.deepEqual(instruction, [{ path: '/topics/falcon.md', kind: 'delete', before: null, after: null }]);
});

test('edits create, change and delete files and skip what no longer fits', async () => {
  const keep = memory();
  const created = await applyFileEdits(keep, [
    { path: '/profile.md', kind: 'add', before: null, after: '- Use emojis.' },
    {
      path: '/topics/falcon.md',
      kind: 'add',
      before: null,
      after: '- Leads the Falcon launch.',
      name: 'Project Falcon',
      description: 'Launch planning',
    },
    { path: '/people/sam.md', kind: 'remove', before: 'absent', after: null },
  ]);
  assert.deepEqual(created, [
    { path: '/profile.md', name: 'Preferences', operation: 'created' },
    { path: '/topics/falcon.md', name: 'Project Falcon', operation: 'created' },
  ]);
  const falcon = (await listMemoryFiles(keep)).find(file => file.path === '/topics/falcon.md');
  assert.equal(falcon.description, 'Launch planning');
  assert.equal(falcon.group, 'topics');

  const changed = await applyFileEdits(keep, [
    { path: '/profile.md', kind: 'change', before: 'Use emojis.', after: 'Avoid emojis.' },
    { path: '/topics/falcon.md', kind: 'add', before: null, after: 'x'.repeat(9000) },
  ]);
  assert.deepEqual(
    changed,
    [{ path: '/profile.md', name: 'Preferences', operation: 'updated' }],
    'too long is skipped',
  );
  assert.equal((await readMemoryFile(keep, '/profile.md')).content, '- Avoid emojis.');

  const seen = new Map([['/topics/falcon.md', falcon.revisionId]]);
  const deletion = { path: '/topics/falcon.md', kind: 'delete', before: null, after: null };
  assert.deepEqual(await applyFileEdits(keep, [deletion]), [], 'a delete needs the revision it was based on');
  await applyFileEdits(keep, [{ path: '/topics/falcon.md', kind: 'add', before: null, after: '- Ships in May.' }]);
  assert.deepEqual(await applyFileEdits(keep, [deletion], seen), [], 'a file edited since is not deleted');
  seen.set(
    '/topics/falcon.md',
    (await listMemoryFiles(keep)).find(file => file.path === '/topics/falcon.md').revisionId,
  );
  const removed = await applyFileEdits(
    keep,
    [deletion, { path: '/profile.md', kind: 'remove', before: '- Avoid emojis.', after: null }],
    seen,
  );
  assert.deepEqual(removed, [
    { path: '/topics/falcon.md', name: 'Project Falcon', operation: 'deleted' },
    { path: '/profile.md', name: 'Preferences', operation: 'deleted' },
  ]);
  assert.deepEqual(
    (await listMemoryFiles(keep)).map(file => [file.path, file.revisionId]),
    [
      ['/profile.md', null],
      ['/you/about.md', null],
    ],
    'You files stay listed when empty',
  );
});
