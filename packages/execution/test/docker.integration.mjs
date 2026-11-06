import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createDockerExecutionBackend } from '../dist/docker.js';

const image = process.env.TEST_EXECUTION_IMAGE;
const gatewayImage = process.env.TEST_EXECUTION_GATEWAY_IMAGE;
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/, 'TEST_EXECUTION_IMAGE must name an immutable local image');
assert.match(
  gatewayImage ?? '',
  /^sha256:[a-f0-9]{64}$/,
  'TEST_EXECUTION_GATEWAY_IMAGE must name an immutable local image',
);

const profile = {
  id: 'small',
  resources: { kind: 'limited', cpuMillis: 500, memoryMiB: 1024, diskBytes: 67108864 },
};
const policy = {
  version: 1,
  baseRevision: image.slice(7),
  defaultProfile: profile.id,
  profiles: [profile],
  network: 'public-only',
  idleTimeoutSeconds: 300,
  limits: {
    jobTimeoutSeconds: 30,
    queueTimeoutSeconds: 30,
    stopGraceSeconds: 2,
    checkpointIntervalSeconds: 10,
    workspaceConcurrency: 1,
    deploymentConcurrency: 1,
    workspaceStorageBytes: 67108864,
    fileBytes: 1048576,
    fileCount: 100,
    outputBytes: 8192,
    jobBudgetPicoUsd: '0',
  },
};

function fixture(t, outputBytes = policy.limits.outputBytes) {
  const backend = createDockerExecutionBackend(
    { ...policy, limits: { ...policy.limits, outputBytes } },
    {
      image,
      gatewayImage,
      runnerId: randomUUID(),
      dns: ['1.1.1.1'],
      deniedNetworks: [],
      pidsLimit: 64,
      helperCpuMillis: 100,
      helperMemoryMiB: 128,
    },
  );
  const allocation = { areaId: randomUUID(), allocationId: randomUUID(), generation: 1 };
  const operation = { signal: AbortSignal.timeout(55000) };
  t.after(async () => {
    const cleanup = { signal: AbortSignal.timeout(20000) };
    await backend.destroy(allocation, cleanup);
    await backend.destroy(allocation, cleanup);
    assert.deepEqual(await backend.inspect(allocation, cleanup), { state: 'absent' });
  });
  return {
    backend,
    allocation,
    operation,
    outputBytes,
    prepare: () =>
      backend.prepare(
        {
          ...allocation,
          profile,
          baseRevision: policy.baseRevision,
          policyRevision: 'a'.repeat(64),
          deadline: new Date(Date.now() + 60000).toISOString(),
        },
        operation,
      ),
    read: async file => Buffer.concat(await Array.fromAsync(backend.readFile({ ...allocation, file }, operation))),
    write: (file, bytes) =>
      backend.writeFile(
        {
          ...allocation,
          file,
          bytes: (async function* () {
            yield bytes;
          })(),
        },
        operation,
      ),
  };
}

function file(path, bytes) {
  return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), executable: false };
}

async function finished(f, job) {
  for (;;) {
    const state = await f.backend.inspectJob(job, f.operation);
    if (state.state !== 'running') return state;
    await delay(100, undefined, { signal: f.operation.signal });
  }
}

const output = (f, job, after = 0, maximumBytes = f.outputBytes) =>
  Array.fromAsync(f.backend.readOutput({ ...job, after, maximumBytes }, f.operation));
const outputBytes = events =>
  Buffer.concat(events.filter(event => event.kind === 'chunk').map(event => Buffer.from(event.data, 'base64')));
const release = (f, path) =>
  execFileSync(
    'docker',
    [
      'exec',
      `tf-execution-${f.allocation.allocationId}`,
      'python3',
      '-I',
      '-c',
      `from pathlib import Path; Path('/work/${path}').touch()`,
    ],
    { timeout: 3000 },
  );

test(
  'Docker restores verified files and replays job receipts without another execution',
  { timeout: 60000 },
  async t => {
    const f = fixture(t);
    assert.deepEqual(await f.backend.inspect(f.allocation, f.operation), { state: 'absent' });
    await f.backend.destroy(f.allocation, f.operation);
    assert.deepEqual(await f.prepare(), { state: 'ready' });
    const bytes = Buffer.alloc(70000, 'a');
    const restored = file('input/data.txt', bytes);
    const empty = file('input/empty.txt', Buffer.alloc(0));
    await f.write(restored, bytes);
    await f.write(empty, Buffer.alloc(0));
    assert.deepEqual(await f.read(restored), bytes);
    assert.deepEqual(await f.read(empty), Buffer.alloc(0));
    await assert.rejects(f.read({ ...empty, path: 'missing.txt' }), /execution-request-failed/);
    assert.deepEqual(await Array.fromAsync(f.backend.listFiles(f.allocation, f.operation)), [restored, empty]);

    const job = { ...f.allocation, jobId: randomUUID() };
    const request = {
      ...job,
      deadline: new Date(Date.now() + 25000).toISOString(),
      command: {
        program: 'python3',
        args: [
          '-c',
          [
            'import os',
            'from pathlib import Path',
            'assert os.getuid() == 1000',
            "assert 'CapEff:\\t0000000000000000' in Path('/proc/self/status').read_text()",
            "assert set(os.environ) == {'HOME', 'LANG', 'PATH', 'TMPDIR'}",
            "assert len(Path('input/data.txt').read_bytes()) == 70000",
            "with open('counter.txt', 'a') as output: output.write('once\\n')",
            "print('complete')",
          ].join('\n'),
        ],
      },
    };
    await f.backend.startJob(request, f.operation);
    assert.deepEqual(await finished(f, job), { state: 'completed', exitCode: 0 });
    assert.deepEqual(await f.backend.startJob(request, f.operation), { state: 'completed', exitCode: 0 });
    await assert.rejects(
      f.backend.startJob({ ...request, command: { program: 'python3', args: ['--version'] } }, f.operation),
      /execution-request-failed/,
    );
    const output = await Array.fromAsync(f.backend.readOutput({ ...job, after: 0, maximumBytes: 8192 }, f.operation));
    assert.equal(outputBytes(output).toString(), 'complete\n');
    assert.equal(output.at(-1).kind, 'end');
    assert.deepEqual(
      await Array.fromAsync(
        f.backend.readOutput({ ...job, after: output.at(-1).sequence, maximumBytes: 8192 }, f.operation),
      ),
      [],
    );
    const files = await Array.fromAsync(f.backend.listFiles(f.allocation, f.operation));
    assert.equal((await f.read(files.find(entry => entry.path === 'counter.txt'))).toString(), 'once\n');
    await f.backend.removeFile({ ...f.allocation, path: empty.path }, f.operation);
    await assert.rejects(f.read(empty), /execution-request-failed/);
    await f.backend.removeFile({ ...f.allocation, path: restored.path }, f.operation);
    await assert.rejects(f.read(restored), /execution-request-failed/);

    const stopped = { ...f.allocation, jobId: randomUUID() };
    await f.backend.startJob(
      {
        ...stopped,
        command: { program: 'python3', args: ['-c', 'import time; time.sleep(60)'] },
        deadline: new Date(Date.now() + 20000).toISOString(),
      },
      f.operation,
    );
    assert.deepEqual(await f.backend.stopJob(stopped, f.operation), { state: 'cancelled' });
    assert.deepEqual(await f.backend.inspectJob(stopped, f.operation), { state: 'cancelled' });
    assert.deepEqual(await f.backend.inspectJob(job, f.operation), { state: 'completed', exitCode: 0 });
  },
);

test(
  'output truncation is a new immutable event and arbitrary bytes fit bounded pages',
  { timeout: 60000 },
  async t => {
    const small = fixture(t, 4);
    await small.prepare();
    const job = { ...small.allocation, jobId: randomUUID() };
    await small.backend.startJob(
      {
        ...job,
        deadline: new Date(Date.now() + 20000).toISOString(),
        command: {
          program: 'python3',
          args: [
            '-c',
            "import os,time\nfrom pathlib import Path\nos.write(1,b'ABCD')\nwhile not Path('gate').exists(): time.sleep(.01)\nos.write(1,b'EFGH')",
          ],
        },
      },
      small.operation,
    );
    let early;
    do {
      early = await output(small, job);
      if (!early.length) await delay(30, undefined, { signal: small.operation.signal });
    } while (!early.length);
    assert.equal(outputBytes(early).toString(), 'ABCD');
    release(small, 'gate');
    assert.deepEqual(await finished(small, job), { state: 'completed', exitCode: 0 });
    const later = await output(small, job, early.at(-1).sequence);
    assert.deepEqual(
      later.map(event => event.kind),
      ['truncated', 'end'],
    );
    assert.deepEqual((await output(small, job)).slice(0, early.length), early);
    await small.backend.destroy(small.allocation, small.operation);

    const binary = fixture(t, 65536);
    await binary.prepare();
    const raw = { ...binary.allocation, jobId: randomUUID() };
    await binary.backend.startJob(
      {
        ...raw,
        deadline: new Date(Date.now() + 20000).toISOString(),
        command: { program: 'python3', args: ['-c', 'import os; os.write(1,bytes(range(256))*256)'] },
      },
      binary.operation,
    );
    assert.deepEqual(await finished(binary, raw), { state: 'completed', exitCode: 0 });
    const events = [];
    let after = 0;
    do {
      const page = await output(binary, raw, after, 8192);
      assert.ok(page.length);
      assert.ok(outputBytes(page).length <= 8192);
      assert.ok(page.every(event => Buffer.byteLength(JSON.stringify(event)) < 65536));
      events.push(...page);
      after = page.at(-1).sequence;
    } while (events.at(-1).kind !== 'end');
    assert.deepEqual(outputBytes(events), Buffer.from(Array.from({ length: 65536 }, (_, index) => index % 256)));
    assert.deepEqual(
      events.map(event => event.sequence),
      events.map((_, index) => index + 1),
    );
    assert.equal(events.filter(event => event.kind === 'end').length, 1);
  },
);

test('a completed parent stays running until its child closes both output pipes', { timeout: 60000 }, async t => {
  const f = fixture(t);
  await f.prepare();
  const job = { ...f.allocation, jobId: randomUUID() };
  await f.backend.startJob(
    {
      ...job,
      deadline: new Date(Date.now() + 20000).toISOString(),
      command: {
        program: 'python3',
        args: [
          '-c',
          "import os,time\nfrom pathlib import Path\nos.write(1,b'early')\nif os.fork(): os._exit(0)\nwhile os.getppid()!=1: time.sleep(.01)\nPath('parent-exited').touch()\nwhile not Path('gate').exists(): time.sleep(.01)\nos.write(2,b'late')\nos._exit(0)",
        ],
      },
    },
    f.operation,
  );
  for (;;) {
    const files = await Array.fromAsync(f.backend.listFiles(f.allocation, f.operation));
    if (files.some(file => file.path === 'parent-exited')) break;
    await delay(30, undefined, { signal: f.operation.signal });
  }
  assert.deepEqual(await f.backend.inspectJob(job, f.operation), { state: 'running' });
  const early = await output(f, job);
  assert.equal(outputBytes(early).toString(), 'early');
  assert.ok(early.every(event => event.kind !== 'end'));
  release(f, 'gate');
  assert.deepEqual(await finished(f, job), { state: 'completed', exitCode: 0 });
  const late = await output(f, job, early.at(-1).sequence);
  assert.equal(outputBytes(late).toString(), 'late');
  assert.ok(late.filter(event => event.kind === 'chunk').every(event => event.stream === 'stderr'));
  assert.equal(late.at(-1).kind, 'end');
});

test('Docker hard timeout stops detached descendants and survives status recovery', { timeout: 60000 }, async t => {
  const f = fixture(t);
  await f.prepare();
  const job = { ...f.allocation, jobId: randomUUID() };
  await f.backend.startJob(
    {
      ...job,
      deadline: new Date(Date.now() + 2000).toISOString(),
      command: {
        program: 'python3',
        args: ['-c', 'import os,time; child=os.fork(); os._exit(0) if child else None; os.setsid(); time.sleep(60)'],
      },
    },
    f.operation,
  );
  await delay(2500);
  assert.deepEqual(await f.backend.inspectJob(job, f.operation), { state: 'timed-out' });
  assert.deepEqual(await f.backend.inspect(f.allocation, f.operation), { state: 'stopped' });
});
