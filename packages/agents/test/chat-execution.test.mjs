import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createChatExecution, runIsolated } from '../src/chat-execution.ts';

const profile = { id: 'small', resources: { kind: 'limited', cpuMillis: 1000, memoryMiB: 512, diskBytes: 1048576 } };
const configuration = {
  mode: 'extension',
  policyRevision: 'a'.repeat(64),
  policy: {
    version: 1,
    baseRevision: 'b'.repeat(64),
    defaultProfile: 'small',
    profiles: [profile],
    network: 'public-only',
    idleTimeoutSeconds: 300,
    limits: { jobTimeoutSeconds: 30, stopGraceSeconds: 1 },
  },
};
const chunk = (sequence, stream, text) => ({
  kind: 'chunk',
  sequence,
  stream,
  data: Buffer.from(text).toString('base64'),
});

function fakeBackend({ events, finish }) {
  const calls = [];
  let polls = 0;
  return {
    calls,
    backend: {
      prepare: async input => (calls.push(['prepare', input]), { state: 'preparing' }),
      inspect: async () => ({ state: 'ready' }),
      startJob: async input => (calls.push(['startJob', input]), { state: 'running' }),
      inspectJob: async () => (++polls < 2 ? { state: 'running' } : finish),
      async *readOutput(input) {
        calls.push(['readOutput', input.after]);
        yield* events.filter(event => event.sequence > input.after).slice(0, 2);
      },
      destroy: async input => (calls.push(['destroy', input]), { state: 'stopped' }),
    },
  };
}

const computer = {
  id: 'computer',
  resources: { kind: 'limited', cpuMillis: 1000, memoryMiB: 2048, diskBytes: 1048576 },
};
const chatConfiguration = { ...configuration, policy: { ...configuration.policy, profiles: [profile, computer] } };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** A backend whose jobs finish at once; `respond` gives each command's stdout and final state. */
function machine(respond = () => ({})) {
  const calls = [];
  const jobs = new Map();
  const files = new Map();
  return {
    calls,
    files,
    backend: {
      prepare: async input => (calls.push(['prepare', input]), { state: 'ready' }),
      inspect: async () => ({ state: 'ready' }),
      async startJob(input) {
        calls.push(['startJob', input]);
        const { stdout = '', finish = { state: 'completed', exitCode: 0 }, start } = respond(input.command) ?? {};
        if (start) return start(input);
        jobs.set(input.jobId, { stdout, finish });
        return finish;
      },
      inspectJob: async input => jobs.get(input.jobId).finish,
      async *readOutput(input) {
        if (input.after) return;
        yield chunk(1, 'stdout', jobs.get(input.jobId).stdout);
        yield { kind: 'end', sequence: 2 };
      },
      stopJob: async input => (calls.push(['stopJob', input]), { state: 'cancelled' }),
      async writeFile(input) {
        calls.push(['writeFile', input.file]);
      },
      readFile: input => (calls.push(['readFile', input.file]), files.get(input.file.path)()),
      destroy: async input => (calls.push(['destroy', input]), { state: 'stopped' }),
    },
  };
}
const run = (fake, input, signal) =>
  createChatExecution(fake.backend, chatConfiguration)(
    { workspaceId: 'w1', conversationId: 'c1', language: 'bash', code: 'make', ...input },
    signal,
  );
const isCheck = command => command.program === 'bash' && command.args[2] === 'check';

test("A chat's runs share one machine per workspace and chat, which is kept between runs", async () => {
  const fake = machine(() => ({ stdout: 'hi\n' }));
  assert.deepEqual(await run(fake, {}), {
    state: 'completed',
    exitCode: 0,
    stdout: 'hi\n',
    stderr: '',
    truncated: false,
  });
  await run(fake, {});
  await run(fake, { workspaceId: 'w2' });
  const prepared = fake.calls.filter(([name]) => name === 'prepare').map(([, input]) => input);
  assert.equal(prepared[0].allocationId, prepared[1].allocationId);
  assert.notEqual(prepared[0].allocationId, prepared[2].allocationId);
  assert.equal(prepared[0].profile.id, 'computer');
  assert.equal(prepared[0].idleSeconds, 1800);
  assert.equal(fake.calls.filter(([name]) => name === 'destroy').length, 0);
  const [, started] = fake.calls.find(([name]) => name === 'startJob');
  assert.deepEqual(started.command, { program: 'bash', args: ['-c', 'make'] });
});

test('Only outputs this run wrote, with matching bytes, are saved; other outputs say why', async () => {
  const good = Buffer.from('pdf');
  const fake = machine(command =>
    isCheck(command) ? { stdout: `ok 3 ${sha(good)}\nunchanged\nmissing\nok 3 ${sha(good)}\n` } : { stdout: '' },
  );
  fake.files.set('a.pdf', async function* () {
    yield good;
  });
  fake.files.set('grown.pdf', async function* () {
    yield good;
    yield good;
  });
  const saved = [];
  await run(fake, {
    outputs: ['a.pdf', 'old.pdf', 'nope.pdf', 'grown.pdf'],
    save: async output => saved.push(output),
  });
  assert.deepEqual(saved, [
    { path: 'a.pdf', bytes: good },
    { path: 'old.pdf', error: 'unchanged' },
    { path: 'nope.pdf', error: 'missing' },
    { path: 'grown.pdf', error: 'unreadable' },
  ]);
  const [, main] = fake.calls.find(([name]) => name === 'startJob');
  const [, check] = fake.calls.findLast(([name]) => name === 'startJob');
  // The marker the run touches is the one the check compares against.
  assert.equal(main.command.args[2], check.command.args[3]);
});

test('A program that fails returns no outputs', async () => {
  const fake = machine(command =>
    isCheck(command) ? assert.fail('checked') : { finish: { state: 'completed', exitCode: 2 } },
  );
  const saved = [];
  await run(fake, { outputs: ['a.pdf'], save: async output => saved.push(output) });
  assert.deepEqual(saved, [{ path: 'a.pdf', error: 'not-run' }]);
});

test('Refused staging removes the staged inputs and keeps the machine', async () => {
  const fake = machine();
  const result = await run(fake, {
    stage: async write => (await write('inputs/a.txt', Buffer.from('a')), false),
  });
  assert.equal(result, undefined);
  const [, written] = fake.calls.find(([name]) => name === 'writeFile');
  assert.deepEqual(written, { path: 'inputs/a.txt', size: 1, sha256: sha('a'), executable: false });
  const [, removed] = fake.calls.findLast(([name]) => name === 'startJob');
  assert.deepEqual(removed.command, { program: 'rm', args: ['-f', '--', 'inputs/a.txt'] });
  assert.equal(fake.calls.filter(([name]) => name === 'destroy').length, 0);
});

test('A run that fails after its inputs were staged destroys the machine', async () => {
  const fake = machine(() => ({
    start: () => {
      throw new Error('backend-down');
    },
  }));
  await assert.rejects(
    run(fake, { stage: async write => (await write('inputs/a.txt', Buffer.from('a')), true) }),
    /backend-down/,
  );
  assert.equal(fake.calls.at(-1)[0], 'destroy');
});

test('A cancelled run stops its job, and destroys the machine when the stop is not confirmed', async () => {
  for (const [stop, destroyed] of [
    [{ state: 'cancelled' }, 0],
    [{ state: 'outcome-unknown' }, 1],
  ]) {
    const controller = new AbortController();
    const fake = machine(() => ({ start: () => (controller.abort(), { state: 'running' }) }));
    fake.backend.stopJob = async () => stop;
    await assert.rejects(run(fake, {}, controller.signal));
    assert.equal(fake.calls.filter(([name]) => name === 'destroy').length, destroyed, stop.state);
  }
});

test('TypeScript chat code runs as an ES module with types stripped', async () => {
  const fake = machine();
  const code = 'const n: number = 2; console.log(await Promise.resolve(n));';
  await run(fake, { language: 'typescript', code });
  const [, started] = fake.calls.find(([name]) => name === 'startJob');
  assert.deepEqual(started.command, { program: 'node', args: ['--input-type=module-typescript', '-e', code] });
});

test('A timeout shorter than the policy limit caps the job deadline', async () => {
  const { backend, calls } = fakeBackend({
    events: [{ kind: 'end', sequence: 1 }],
    finish: { state: 'completed', exitCode: 0 },
  });
  const before = Date.now();
  const command = { program: 'true', args: [] };
  await runIsolated(backend, configuration, { areaId: randomUUID(), command, timeoutMs: 20000 });
  const [, started] = calls.find(([name]) => name === 'startJob');
  const budget = Date.parse(started.deadline) - before;
  assert.ok(budget >= 20000 && budget < 21000, `job budget was ${budget} ms`);
});
