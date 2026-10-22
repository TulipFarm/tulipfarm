import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { residentBytesFromProcStatus, runParserProcess } from '../dist/internal/parser/process.js';
import { parseKnowledgeDocument, KnowledgeParseError, KnowledgeParserBusy } from '../dist/parser.js';

const worker = new URL('./fixtures/parser-process.mjs', import.meta.url);
const input = filename => ({ bytes: Buffer.from('content'), filename, mediaType: 'text/plain' });
const failure = code => error => error instanceof KnowledgeParseError && error.failure === code;
const processFailure = (reason, retryable) => error => {
  assert.ok(error instanceof KnowledgeParseError);
  assert.equal(error.reason, reason);
  assert.equal(error.retryable, retryable);
  assert.equal(error.code, error.failure);
  for (const value of Object.values(error.diagnostics)) assert.ok(Number.isSafeInteger(value));
  assert.ok(!JSON.stringify(error).includes('must-not-reach-child'));
  return true;
};

for (const [filename, reason, retryable] of [
  ['crash', 'abnormal-exit', true],
  ['hang', 'timeout', true],
  ['memory', 'rss-limit', true],
  ['output', 'output-limit', false],
  ['stderr', 'diagnostic-limit', false],
  ['exit', 'abnormal-exit', true],
]) {
  test(`kills and reaps ${filename} process, then accepts another document`, async () => {
    const started = Date.now();
    let pid;
    await assert.rejects(
      runParserProcess(input(filename), {
        worker,
        timeoutMs: filename === 'hang' ? 150 : 5000,
        memoryBytes: filename === 'memory' ? 96 * 1024 * 1024 : 512 * 1024 * 1024,
        onSpawn: value => {
          pid = value;
        },
      }),
      error => {
        processFailure(reason, retryable)(error);
        assert.equal(error.failure, 'resource-limited');
        assert.ok(error.diagnostics.elapsedMs >= 0);
        if (filename === 'crash') assert.ok(error.diagnostics.signalNumber > 0);
        if (filename === 'exit') assert.equal(error.diagnostics.exitCode, 7);
        if (filename === 'memory') assert.ok(error.diagnostics.rssBytes > 96 * 1024 * 1024);
        if (filename === 'output') assert.ok(error.diagnostics.outputBytes > 32 * 1024 * 1024);
        if (filename === 'stderr') assert.ok(error.diagnostics.diagnosticBytes > 16 * 1024);
        return true;
      },
    );
    assert.equal(typeof pid, 'number');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.ok(Date.now() - started < 6000);
    const result = await parseKnowledgeDocument(input('recovery.txt'));
    assert.equal(result.markdown, 'content\n');
  });
}

test('validates process output', async () => {
  await assert.rejects(runParserProcess(input('invalid'), { worker }), error => {
    processFailure('invalid-output', true)(error);
    return failure('malformed')(error);
  });
});

test('memory monitor reads Linux RSS and treats an exiting process without an address space as empty', () => {
  assert.equal(residentBytesFromProcStatus('Name:\tnode\nState:\tR (running)\nVmRSS:\t   2048 kB\n'), 2048 * 1024);
  assert.equal(residentBytesFromProcStatus('Name:\tnode\nState:\tZ (zombie)\n'), 0);
  assert.equal(residentBytesFromProcStatus('Name:\tnode\nState:\tR (running)\nThreads:\t1\n'), 0);
  assert.throws(() => residentBytesFromProcStatus(''), /Parser memory is unavailable/);
});

test('memory monitor failure kills and reaps the child without exposing its error', async () => {
  let pid;
  await assert.rejects(
    runParserProcess(input('hang'), {
      worker,
      onSpawn: value => {
        pid = value;
      },
      residentBytes: async () => {
        throw new Error('must-not-reach-child');
      },
    }),
    processFailure('memory-monitor', true),
  );
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal((await parseKnowledgeDocument(input('after.txt'))).markdown, 'content\n');
});

for (const mode of ['throw', 'error-event']) {
  test(`${mode} spawn errors release capacity and never expose operating-system messages`, async context => {
    const spawn = childProcess.spawn;
    const mocked = context.mock.method(childProcess, 'spawn', (_command, args, options) => {
      if (mode === 'throw') throw new Error('must-not-reach-child');
      return spawn('/nonexistent-knowledge-parser-must-not-reach-child', args, options);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(runParserProcess(input('hang'), { worker }), processFailure('spawn', true));
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal((await parseKnowledgeDocument(input('after.txt'))).markdown, 'content\n');
  });
}

test('content limits and document failures are not retryable and diagnostics are numeric-only', async () => {
  await assert.rejects(runParserProcess(input('content-limit'), { worker }), processFailure('content-limit', false));
  await assert.rejects(
    runParserProcess({ ...input('large'), bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }),
    processFailure('content-limit', false),
  );
  const error = new KnowledgeParseError('unsupported', {
    diagnostics: {
      elapsedMs: 10,
      exitCode: -1,
      signalNumber: 9,
      rssBytes: Infinity,
      outputBytes: -1,
      diagnosticBytes: 'secret',
      stderr: 'must-not-reach-child',
    },
  });
  assert.equal(error.reason, 'document-rejected');
  assert.equal(error.retryable, false);
  assert.deepEqual(error.diagnostics, { elapsedMs: 10, exitCode: -1, signalNumber: 9 });
  assert.ok(Object.isFrozen(error.diagnostics));
});

test('never forwards credentials or runtime injection variables', async () => {
  const keys = ['AZURE_FOUNDRY_API_KEY', 'FIRECRAWL_API_KEY', 'NODE_OPTIONS', 'NAPI_RS_NATIVE_LIBRARY_PATH'];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = 'must-not-reach-child';
    await assert.rejects(runParserProcess(input('credentials'), { worker }), failure('unsupported'));
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test('cancellation terminates the child and releases admission capacity', async () => {
  const controller = new AbortController();
  let pid;
  const pending = runParserProcess(input('hang'), {
    worker,
    signal: controller.signal,
    onSpawn: value => {
      pid = value;
    },
  });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, processFailure('cancelled', false));
  assert.equal(typeof pid, 'number');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(
    runParserProcess(input('hang'), { worker, signal: controller.signal }),
    processFailure('cancelled', false),
  );
  assert.equal((await parseKnowledgeDocument(input('after.txt'))).markdown, 'content\n');
});

test('bounds admission rather than accumulating queued upload bytes', async () => {
  const controller = new AbortController();
  const first = runParserProcess(input('hang'), { worker, signal: controller.signal });
  const second = runParserProcess(input('hang'), { worker, signal: controller.signal });
  const finished = Promise.allSettled([first, second]);
  await assert.rejects(runParserProcess(input('third'), { worker }), KnowledgeParserBusy);
  controller.abort();
  assert.deepEqual(
    (await finished).map(result => result.status),
    ['rejected', 'rejected'],
  );
  assert.equal((await parseKnowledgeDocument(input('after.txt'))).markdown, 'content\n');
});
