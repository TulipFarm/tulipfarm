import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFileOutput } from '../../conversations/src/file-outputs.ts';
import { inferWithTools } from '../src/inference.ts';
import { nativeChatTools } from '../src/native-tools.ts';
import {
  azureStreamReply,
  completionReply,
  isCompletionRequest,
  nativeReply,
  nativeRoutes,
  use,
} from './native-fixture.mjs';

const fileId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const create = { name: 'Report', format: 'md', content: '# Report' };
const quota = { error: 'quota', instruction: 'No file was created. Workspace storage is full.' };
const saved = {
  file: { id: fileId, name: 'Report.md', mediaType: 'text/markdown', size: 8, parentId: null },
  derivedFrom: [],
};
const full =
  "I couldn't save the file because workspace storage is full. Free up some space, then ask me to try again.";
const options = { chatFiles: true };
const models = ['grok-4.3', 'Kimi-K2.6', 'DeepSeek-V4-Pro'];
const route = model => ({ ...nativeRoutes.azure, model });

function provider(t, sse, replies, checkFails = false) {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body))
      return checkFails
        ? Response.json({ error: { code: 'BadRequest' } }, { status: 400 })
        : Response.json(completionReply('azure'));
    const reply = replies.length > 1 ? replies.shift() : replies[0];
    assert.ok(reply, 'fixture exhausted');
    return sse ? azureStreamReply(reply) : Response.json(reply);
  });
}

test('listing and saving are offered beside file reading without discovery', () => {
  const names = nativeChatTools(undefined, false, new Set(), true).tools.map(tool => tool.name);
  for (const name of ['files_list', 'files_create', 'files_read']) assert.ok(names.includes(name), name);
});

test('a search phrase is data, even when it contains action words', async t => {
  provider(t, true, [nativeReply('azure', { text: 'No matching files.' })]);
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'List files whose name contains "read table"' }],
    async call => {
      assert.equal(call.tool, 'files.list');
      assert.equal(call.query, 'read table');
      return { items: [{ id: fileId, kind: 'file', name: 'read table.md' }], next: null };
    },
    undefined,
    false,
    null,
    options,
  );
  assert.equal(result.text, 'read table.md');
});

for (const model of models)
  for (const sse of [false, true]) {
    const title = `${model} ${sse ? 'SSE' : 'JSON'}`;
    test(`${title} lists every matching name across pages without attempting the model's unrelated read`, async t => {
      provider(t, sse, [
        nativeReply('azure', { calls: [use('files.read', { source: 'invented-id' })] }),
        nativeReply('azure', { text: 'No files exist.' }),
      ]);
      const calls = [];
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'List the files in my Files whose name contains X' }],
        async call => {
          calls.push(call);
          assert.equal(call.tool, 'files.list');
          assert.equal(call.query, 'X');
          return call.after
            ? { items: [{ id: secondId, kind: 'file', name: 'X budget.xlsx' }], next: null }
            : { items: [{ id: fileId, kind: 'file', name: 'X notes.md' }], next: fileId };
        },
        undefined,
        false,
        null,
        options,
      );
      assert.equal(calls.length, 2);
      assert.match(result.text, /X notes\.md/);
      assert.match(result.text, /X budget\.xlsx/);
      assert.doesNotMatch(result.text, /No files/);
    });

    test(`${title} creates a new file without dispatching an unrelated read or API request`, async t => {
      provider(t, sse, [
        nativeReply('azure', { calls: [use('files.read', {})] }),
        nativeReply('azure', { calls: [use('api.request', { method: 'GET', url: 'https://example.com' })] }),
        nativeReply('azure', { calls: [use('files.create', create)] }),
        nativeReply('azure', { text: 'Report.md is saved in Files.' }),
      ]);
      const calls = [];
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'Create a markdown file.' }],
        async call => {
          calls.push(call.tool);
          return saved;
        },
        undefined,
        false,
        null,
        options,
      );
      assert.deepEqual(calls, ['files.create']);
      assert.equal(result.text, 'Report.md is saved in Files.');
    });

    for (const claim of ['Your Excel workbook is ready in Files.', 'I created Report.xlsx.'])
      test(`${title} refuses ${JSON.stringify(claim)} after failed saves, including resumed turns`, async t => {
        provider(t, sse, [
          nativeReply('azure', { calls: [use('files.create', create)] }),
          nativeReply('azure', { text: claim }),
        ]);
        const previews = [];
        const result = await inferWithTools(
          route(model),
          [{ role: 'user', text: 'Create a markdown report in Files.' }],
          async () => quota,
          undefined,
          false,
          null,
          { ...options, priorCalls: 1, answerText: update => previews.push(update.text) },
        );
        assert.equal(result.text, full);
        assert.ok(!previews.some(text => text.includes(claim)), 'an unchecked success never streams');
      });

    test(`${title} does not trust a failing completion check after a failed save`, async t => {
      provider(
        t,
        sse,
        [
          nativeReply('azure', { calls: [use('files.create', create)] }),
          nativeReply('azure', { text: 'The workbook is ready in Files.' }),
        ],
        true,
      );
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'Create a report.' }],
        async () => quota,
        undefined,
        false,
        null,
        options,
      );
      assert.equal(result.text, full);
    });

    for (const format of ['md', 'xlsx'])
      test(`${title} saves ${format} once and leaves a successfully saved reply unchanged`, async t => {
        const text = `Report.${format} is saved in Files.`;
        provider(t, sse, [
          nativeReply('azure', {
            calls: [
              use('files.create', {
                ...create,
                format,
                content:
                  format === 'md'
                    ? '# Report'
                    : JSON.stringify({ sheets: [{ name: 'Report', rows: [['Total', 42]] }] }),
              }),
            ],
          }),
          nativeReply('azure', { text }),
        ]);
        const persisted = [];
        const result = await inferWithTools(
          route(model),
          [{ role: 'user', text: `Create a ${format} report.` }],
          async call => {
            assert.equal(call.tool, 'files.create');
            const output = await createFileOutput(
              {
                createDerived: async (_workspace, _user, id, metadata, bytes) => {
                  const file = { id, ...metadata, size: bytes.byteLength };
                  persisted.push(file);
                  return file;
                },
              },
              {
                workspaceId: fileId,
                actor: { kind: 'human', userId: fileId, membershipId: fileId },
                autonomous: false,
                origin: { turnId: secondId },
              },
              call,
            );
            assert.ok(output.file, JSON.stringify(output));
            assert.equal(output.file.id, persisted[0].id);
            return output;
          },
          undefined,
          false,
          null,
          options,
        );
        assert.equal(result.text, text);
        assert.equal(persisted.length, 1);
        assert.equal(persisted[0].name, `Report.${format}`);
      });

    test(`${title} preserves non-file work`, async t => {
      const text = 'The public page describes apples.';
      provider(t, sse, [
        nativeReply('azure', { calls: [use('web.fetch', { url: 'https://example.com' })] }),
        nativeReply('azure', { text }),
      ]);
      const result = await inferWithTools(
        route(model),
        [{ role: 'user', text: 'Read this public page.' }],
        async () => ({ text: 'Apples' }),
        undefined,
        false,
        null,
        options,
      );
      assert.equal(result.text, text);
    });

    test(`${title} rejects a false saved claim from the fallback route`, async t => {
      let round = 0;
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        if (String(url).includes('anthropic'))
          return Response.json({ error: { type: 'api_error', message: 'Fixture unavailable' } }, { status: 500 });
        if (isCompletionRequest(JSON.parse(init.body))) return Response.json(completionReply('azure'));
        const reply = nativeReply(
          'azure',
          ++round === 1 ? { calls: [use('files.create', create)] } : { text: 'Your workbook is ready in Files.' },
        );
        return sse ? azureStreamReply(reply) : Response.json(reply);
      });
      const result = await inferWithTools(
        nativeRoutes.anthropic,
        [{ role: 'user', text: 'Create a markdown file.' }],
        async () => quota,
        undefined,
        false,
        null,
        { ...options, fallback: { route: route(model), label: model } },
      );
      assert.equal(result.fallback, model);
      assert.equal(result.text, full);
    });
  }

test('a resumed successful save keeps its reply without repeating the save', async t => {
  const text = 'Report.md is saved in Files.';
  provider(t, true, [nativeReply('azure', { text })]);
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Create a markdown file.' }],
    () => assert.fail('Do not repeat a saved file'),
    undefined,
    false,
    null,
    {
      ...options,
      priorCalls: 1,
      priorToolCalls: [{ tool: 'files.create', ...create }],
      priorFileResults: [{ call: { tool: 'files.create', ...create }, result: saved }],
    },
  );
  assert.equal(result.text, text);
});

for (const source of [undefined, 'unknown', fileId])
  test(`a failed read of ${source ?? 'no ID'} recovers with a listing, not an empty-library claim`, async t => {
    provider(t, true, [nativeReply('azure', { calls: [use('files.read', source ? { source } : {})] })]);
    const calls = [];
    const result = await inferWithTools(
      nativeRoutes.azure,
      [{ role: 'user', text: 'Read my file.' }],
      async call => {
        calls.push(call);
        return call.tool === 'files.read'
          ? { error: source ? 'file-not-found' : 'file-source-required' }
          : { items: [{ id: fileId, kind: 'file', name: 'Report.md' }], next: null };
      },
      undefined,
      false,
      null,
      options,
    );
    assert.deepEqual(
      calls.map(call => call.tool),
      ['files.read', 'files.list'],
    );
    assert.equal(result.text, 'Report.md');
  });

for (const failure of [
  { error: 'invalid-content', instruction: 'No file was created. bad sheet name' },
  { error: 'provider-error', instruction: 'Private provider details' },
])
  test(`a ${failure.error} save failure gives only a safe reason`, async t => {
    provider(t, false, [
      nativeReply('azure', { calls: [use('files.create', create)] }),
      nativeReply('azure', { text: 'Your file is ready.' }),
    ]);
    const result = await inferWithTools(
      nativeRoutes.azure,
      [{ role: 'user', text: 'Create a file.' }],
      async () => failure,
      undefined,
      false,
      null,
      options,
    );
    assert.equal(
      result.text,
      failure.error === 'invalid-content'
        ? "I couldn't save the file because part of it isn't valid. Bad sheet name. Ask me to fix it and try again."
        : "I couldn't save the file. Ask me to try again.",
    );
  });

test('a different successful write cannot back a failed file save', async t => {
  provider(t, false, [
    nativeReply('azure', { calls: [use('files.rename', { fileId, name: 'Renamed' })] }),
    nativeReply('azure', { calls: [use('files.create', create)] }),
    nativeReply('azure', { text: 'Report.xlsx is ready in Files.' }),
  ]);
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Rename a file and create a report.' }],
    async call => (call.tool === 'files.create' ? quota : { status: 'pending', id: secondId }),
    undefined,
    false,
    null,
    { ...options, preloadedTools: ['files.rename'] },
  );
  assert.equal(result.text, full);
});

test('a successful save is not replaced when a later save fails', async t => {
  const text = 'Report.md is saved. The second file could not be saved.';
  provider(t, false, [
    nativeReply('azure', { calls: [use('files.create', create)] }),
    nativeReply('azure', { calls: [use('files.create', { ...create, name: 'Second' })] }),
    nativeReply('azure', { text }),
  ]);
  let calls = 0;
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Create two reports.' }],
    async () => (++calls === 1 ? saved : quota),
    undefined,
    false,
    null,
    options,
  );
  assert.equal(result.text, text);
});

test('a later read failure does not replace a successful file reply with a listing', async t => {
  const text = 'Report.md is saved. The source file was not available.';
  provider(t, true, [
    nativeReply('azure', { calls: [use('files.create', create)] }),
    nativeReply('azure', { calls: [use('files.read', { source: secondId })] }),
    nativeReply('azure', { text }),
  ]);
  const calls = [];
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Create a report and read my source.' }],
    async call => {
      calls.push(call.tool);
      return call.tool === 'files.create' ? saved : { error: 'file-not-found' };
    },
    undefined,
    false,
    null,
    options,
  );
  assert.deepEqual(calls, ['files.create', 'files.read']);
  assert.equal(result.text, text);
});

test('file work shares a 50-call turn allowance without changing unrelated work', async t => {
  let calls = 0;
  provider(t, false, [
    nativeReply('azure', { calls: [use('files.read', { source: fileId })] }),
    nativeReply('azure', { calls: [use('files.read', { source: secondId })] }),
    nativeReply('azure', { text: 'Read the files.' }),
  ]);
  await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Read the attached file.' }],
    async () => {
      calls++;
      return { file: 'contents' };
    },
    undefined,
    false,
    null,
    { ...options, priorCalls: 49 },
  );
  assert.equal(calls, 1);
});

test('mentioning file fields does not cap or rewrite non-file work', async t => {
  const text = 'The public guide describes file fields.';
  provider(t, true, [
    nativeReply('azure', { calls: [use('web.fetch', { url: 'https://example.com/one' })] }),
    nativeReply('azure', { calls: [use('web.fetch', { url: 'https://example.com/two' })] }),
    nativeReply('azure', { text }),
  ]);
  let calls = 0;
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Read this public guide to file fields.' }],
    async () => {
      calls++;
      return { text: 'Guide' };
    },
    undefined,
    false,
    null,
    { ...options, priorCalls: 49 },
  );
  assert.equal(calls, 2);
  assert.equal(result.text, text);
});

test('three identical failed file operations stop instead of looping', async t => {
  provider(t, false, [nativeReply('azure', { calls: [use('files.list', { query: 'report' })] })]);
  let calls = 0;
  const result = await inferWithTools(
    nativeRoutes.azure,
    [{ role: 'user', text: 'Organize my files.' }],
    async () => {
      calls++;
      return { error: 'file-not-found' };
    },
    undefined,
    false,
    null,
    options,
  );
  assert.equal(calls, 3);
  assert.equal(result.text, 'I stopped because the same file request kept failing. Ask me to try again.');
});
