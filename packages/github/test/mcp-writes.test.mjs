import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchGitHubWrite } from '../dist/write-provider.js';
import { mcpWriteCases, mcpWriteFixture } from './mcp-write-fixture.mjs';

const credential = {
  accessToken: 'synthetic-private-credential',
  identity: { id: '123', login: 'owner' },
  scopes: ['repo'],
};
for (const item of mcpWriteCases)
  test(`official MCP HTTP ${item.operation.kind} retains a qualified receipt`, async t => {
    const f = await mcpWriteFixture({ item });
    t.after(f.close);
    const result = await dispatchGitHubWrite({
      operation: item.operation,
      credential,
      bindings: f.bindings,
      fetcher: f.fetcher,
      authorize: async () => true,
    });
    assert.deepEqual(result, { status: 'succeeded', result: item.receipt });
    assert.deepEqual(f.calls, [{ name: item.name, arguments: item.args }]);
  });

const textResult = text => ({ content: [{ type: 'text', text }] });
for (const item of mcpWriteCases)
  test(`official MCP HTTP ${item.operation.kind} fails closed on unqualified outputs`, async () => {
    const invalid = [
      textResult('Success'),
      textResult('{}'),
      textResult('null'),
      { content: [] },
      { content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] },
      { content: [...textResult(item.text).content, ...textResult('Failed').content] },
      { ...textResult(item.text), isError: true },
      { ...textResult(item.text), structuredContent: { unexpected: true } },
      textResult(`${item.text}\n${credential.accessToken}`),
      textResult('x'.repeat(131073)),
    ];
    if (item.operation.kind === 'pull.review')
      invalid.push(
        textResult('pending pull request created'),
        textResult('pending pull request review successfully submitted'),
        textResult('pull request review submitted successfully\n'),
        textResult(JSON.stringify({ id: 99 })),
      );
    else if (item.operation.kind === 'pull.merge')
      invalid.push(
        textResult(JSON.stringify({ merged: false, sha: 'a'.repeat(40) })),
        textResult(JSON.stringify({ merged: true, sha: 'main' })),
        textResult(JSON.stringify({ merged: true })),
      );
    else {
      const value = JSON.parse(item.text);
      for (const id of [77, '', '0', '-77', '077', '7.7', '7e1', '9223372036854775808'])
        invalid.push(textResult(JSON.stringify({ ...value, id })));
      for (const url of [
        value.url.replace('github.com', 'evil.test'),
        value.url.replace('private', 'other'),
        value.url.replace('/7', '/9'),
        `${value.url}?token=unexpected`,
      ])
        if (url !== value.url) invalid.push(textResult(JSON.stringify({ ...value, url })));
      invalid.push(textResult(JSON.stringify({ ...value, extra: true })), textResult(JSON.stringify({ id: value.id })));
      if ('pullRequestId' in item.operation && item.operation.kind !== 'pull.comment')
        invalid.push(textResult(JSON.stringify({ ...value, id: '999' })));
    }
    for (const result of invalid) {
      const f = await mcpWriteFixture({ item, result });
      try {
        assert.deepEqual(
          await dispatchGitHubWrite({
            operation: item.operation,
            credential,
            bindings: f.bindings,
            fetcher: f.fetcher,
            authorize: async () => true,
          }),
          { status: 'unknown', result: null },
        );
        assert.deepEqual(f.calls, [{ name: item.name, arguments: item.args }]);
      } finally {
        await f.close();
      }
    }
  });

test('reviewed output schema is validated by the shared session before response parsing', async () => {
  const item = mcpWriteCases.find(item => item.operation.kind === 'pull.update');
  const value = JSON.parse(item.text);
  const outputSchema = {
    type: 'object',
    properties: { id: { const: '77' }, url: { type: 'string' } },
    required: ['id', 'url'],
    additionalProperties: false,
  };
  for (const [structuredContent, status] of [
    [value, 'succeeded'],
    [undefined, 'unknown'],
    [{ ...value, id: '999' }, 'unknown'],
  ]) {
    const f = await mcpWriteFixture({
      item,
      outputSchema,
      result: { ...textResult(item.text), ...(structuredContent ? { structuredContent } : {}) },
    });
    try {
      assert.deepEqual(
        await dispatchGitHubWrite({
          operation: item.operation,
          credential,
          bindings: f.bindings,
          fetcher: f.fetcher,
          authorize: async () => true,
        }),
        { status, result: status === 'succeeded' ? { id: '77', number: 7 } : null },
      );
      assert.equal(f.calls.length, 1);
    } finally {
      await f.close();
    }
  }
});
