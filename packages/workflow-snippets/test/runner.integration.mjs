import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSnippetRunner } from '../src/index.ts';

test('isolated JavaScript and Python return JSON and enforce process boundaries', { timeout: 120000 }, async () => {
  assert.ok(process.env.SNIPPET_TEST_IMAGE, 'Supply the local image repository digest');
  const runner = createSnippetRunner({
    image: process.env.SNIPPET_TEST_IMAGE,
    runtime: 'runc',
    allowLocalRunc: true,
    timeoutMs: 15000,
  });
  assert.deepEqual(
    await runner.execute({
      language: 'javascript',
      source: 'return {total: input.price * input.quantity}',
      input: { price: 3, quantity: 4 },
    }),
    { total: 12 },
  );
  assert.deepEqual(
    await runner.execute({
      language: 'python',
      source: 'return {"total": input["price"] * input["quantity"]}',
      input: { price: 3, quantity: 4 },
    }),
    { total: 12 },
  );
  assert.deepEqual(
    await runner.execute({
      language: 'python',
      source: 'import os\nreturn {"uid": os.getuid(), "secret": os.getenv("SNIPPET_TEST_SECRET")}',
      input: null,
    }),
    { uid: 65534, secret: null },
  );
  await assert.rejects(
    runner.execute({ language: 'python', source: 'open("/runner/escape", "w").write("x")\nreturn 1', input: null }),
    /execution-failed/,
  );
  await assert.rejects(
    runner.execute({
      language: 'python',
      source: 'import socket\nsocket.create_connection(("1.1.1.1", 443), 1)\nreturn 1',
      input: null,
    }),
    /execution-failed/,
  );
  const short = createSnippetRunner({
    image: process.env.SNIPPET_TEST_IMAGE,
    runtime: 'runc',
    allowLocalRunc: true,
    timeoutMs: 1000,
  });
  await assert.rejects(short.execute({ language: 'javascript', source: 'while (true) {}', input: null }), /deadline/);
  await assert.rejects(
    runner.execute({ language: 'javascript', source: 'return "x".repeat(200000)', input: null }),
    /output-limit/,
  );
  assert.equal(await runner.execute({ language: 'javascript', source: 'return input + 1', input: 8 }), 9);
});
