import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { codingRunCallSchema, codingRunScript, createCodingRuns, planRequiredMessage } from '../src/coding-runs.ts';
import { discoverToolNames } from '../src/tools.ts';

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
    limits: { jobTimeoutSeconds: 3600, stopGraceSeconds: 1 },
  },
};
const descriptor = {
  capabilities: { secrets: true },
  templates: ['claude-code', 'codex', 'copilot'],
};
const planToken = 'plan-token-real-value';
const githubToken = 'gho_github-real-value';
const actor = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
const context = () => ({
  workspaceId: randomUUID(),
  actor,
  conversationId: randomUUID(),
  turnId: randomUUID(),
  callId: randomUUID(),
});
const call = { tool: 'coding.run', repository: 'octo/app', task: 'Fix the failing test', agent: 'claude-code' };

function fakeBackend({ stdout = '', finish = { state: 'completed', exitCode: 0 }, templates } = {}) {
  const calls = [];
  const data = Buffer.from(stdout).toString('base64');
  return {
    calls,
    backend: {
      descriptor: { ...descriptor, ...(templates ? { templates } : {}) },
      prepare: async input => (calls.push(['prepare', input]), { state: 'ready' }),
      inspect: async () => ({ state: 'ready' }),
      startJob: async input => (calls.push(['startJob', input]), { state: 'running' }),
      inspectJob: async () => finish,
      async *readOutput(input) {
        if (input.after === 0 && stdout) yield { kind: 'chunk', sequence: 1, stream: 'stdout', data };
        yield { kind: 'end', sequence: 2 };
      },
      destroy: async input => (calls.push(['destroy', input]), { state: 'stopped' }),
    },
  };
}
function fakeServices(overrides = {}) {
  const approvals = [];
  return {
    approvals,
    services: {
      enabled: async () => true,
      hasPlan: async () => true,
      plan: async () => ({ connectionId: randomUUID(), ownerMembershipId: actor.membershipId, token: planToken }),
      github: async () => githubToken,
      approve: async request => (approvals.push(request), 'approved'),
      ...overrides,
    },
  };
}
const summary = value =>
  `TULIPFARM_CODING_RUN ${JSON.stringify({ stage: 'done', exitCode: 0, message: 'Fixed it.', files: ['src/a.ts'], diff: 'diff --git a/src/a.ts b/src/a.ts\n', diffTruncated: false, log: '', ...value })}\n`;

test('An approved run starts the agent template with held secrets, never the tokens themselves', async () => {
  const { backend, calls } = fakeBackend({ stdout: summary({}) });
  const { services, approvals } = fakeServices();
  const result = await createCodingRuns(backend, configuration, services).run(context(), call);
  assert.equal(result.status, 'completed');
  assert.equal(result.message, 'Fixed it.');
  assert.deepEqual(result.files, ['src/a.ts']);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].repository, 'octo/app');
  assert.equal(approvals[0].planOwnerMembershipId, actor.membershipId);
  const [, prepared] = calls.find(([name]) => name === 'prepare');
  assert.equal(prepared.profile.template, 'claude-code');
  assert.deepEqual(
    prepared.secrets.map(({ name, env, hosts, header, format }) => ({ name, env, hosts, header, format })),
    [
      { name: 'git', env: undefined, hosts: ['github.com'], header: 'Authorization', format: 'Basic {value}' },
      {
        name: 'plan',
        env: 'CLAUDE_CODE_OAUTH_TOKEN',
        hosts: ['api.anthropic.com'],
        header: 'Authorization',
        format: 'Bearer {value}',
      },
    ],
  );
  assert.equal(prepared.secrets[1].value, planToken);
  assert.equal(Buffer.from(prepared.secrets[0].value, 'base64').toString(), `x-access-token:${githubToken}`);
  const [, started] = calls.find(([name]) => name === 'startJob');
  const job = JSON.stringify(started);
  for (const secret of [planToken, githubToken, prepared.secrets[0].value]) assert.equal(job.includes(secret), false);
  assert.equal(started.command.program, 'bash');
  assert.deepEqual(started.command.args.slice(3, 7), ['octo/app', 'Fix the failing test', '', 'claude-code']);
  assert.equal(calls.at(-1)[0], 'destroy');
});

test('Each agent gets its own plan secret', async () => {
  for (const [agent, env, hosts] of [
    ['codex', 'CODEX_API_KEY', ['api.openai.com']],
    ['copilot', 'COPILOT_GITHUB_TOKEN', ['api.github.com', 'api.githubcopilot.com', '*.githubcopilot.com']],
  ]) {
    const { backend, calls } = fakeBackend({ stdout: summary({}) });
    await createCodingRuns(backend, configuration, fakeServices().services).run(context(), { ...call, agent });
    const [, prepared] = calls.find(([name]) => name === 'prepare');
    assert.equal(prepared.profile.template, agent);
    assert.equal(prepared.secrets[1].env, env);
    assert.deepEqual(prepared.secrets[1].hosts, hosts);
  }
});

test('Without an eligible plan the member is told to connect one, and nothing runs', async () => {
  const { backend, calls } = fakeBackend();
  const { services, approvals } = fakeServices({ plan: async () => null });
  for (const [agent, message] of [
    ['claude-code', 'Connect your Claude plan in Settings → Models to use Claude Code.'],
    ['codex', 'Connect your ChatGPT plan in Settings → Models to use Codex.'],
    ['copilot', 'Connect your GitHub Copilot plan in Settings → Models to use Copilot CLI.'],
  ]) {
    assert.equal(planRequiredMessage(agent), message);
    assert.deepEqual(await createCodingRuns(backend, configuration, services).run(context(), { ...call, agent }), {
      status: 'plan-required',
      message,
    });
  }
  assert.equal(approvals.length, 0);
  assert.equal(calls.length, 0);
});

test('Nothing runs until the member approves the exact run', async () => {
  const { backend, calls } = fakeBackend();
  let github = 0;
  for (const [decision, status] of [
    ['waiting', 'awaiting-approval'],
    ['rejected', 'rejected'],
  ]) {
    const { services } = fakeServices({ approve: async () => decision, github: async () => (github++, githubToken) });
    assert.deepEqual(await createCodingRuns(backend, configuration, services).run(context(), call), { status });
  }
  assert.equal(github, 0);
  assert.equal(calls.length, 0);
});

test('A chat without a selected GitHub account is asked to choose one before the machine starts', async () => {
  const { backend, calls } = fakeBackend();
  const { services } = fakeServices({ github: async () => null });
  const result = await createCodingRuns(backend, configuration, services).run(context(), call);
  assert.equal(result.status, 'github-account-required');
  assert.match(result.instruction, /github\.personal\.account/);
  assert.equal(calls.length, 0);
});

test('The tool is offered only with the flag on, agent templates and a plan', async () => {
  const runs = (backend, overrides) => createCodingRuns(backend, configuration, fakeServices(overrides).services);
  const workspaceId = randomUUID();
  assert.equal(await runs(fakeBackend().backend).offered(workspaceId, actor.membershipId), true);
  assert.equal(
    await runs(fakeBackend().backend, { enabled: async () => false }).offered(workspaceId, actor.membershipId),
    false,
  );
  assert.equal(
    await runs(fakeBackend().backend, { hasPlan: async () => false }).offered(workspaceId, actor.membershipId),
    false,
  );
  assert.equal(await runs(fakeBackend({ templates: [] }).backend).offered(workspaceId, actor.membershipId), false);
  const plain = fakeBackend().backend;
  plain.descriptor = { capabilities: {} };
  assert.equal(await runs(plain).offered(workspaceId, actor.membershipId), false);
  const onlyCodex = fakeBackend({ templates: ['codex'] }).backend;
  const asked = [];
  const offered = await runs(onlyCodex, { hasPlan: async (_w, _m, provider) => (asked.push(provider), false) }).offered(
    workspaceId,
    actor.membershipId,
  );
  assert.equal(offered, false);
  assert.deepEqual(asked, ['chatgpt']);
  await assert.rejects(runs(onlyCodex).run(context(), call), /coding-run-unavailable/);
  await assert.rejects(
    runs(fakeBackend().backend, { enabled: async () => false }).run(context(), call),
    /coding-run-unavailable/,
  );
});

test('Chat lists coding.run only when the reply offers it', () => {
  assert.equal(discoverToolNames({ kind: 'chat' }).includes('coding.run'), false);
  assert.equal(discoverToolNames({ kind: 'chat', codingRuns: true }).includes('coding.run'), true);
  assert.equal(discoverToolNames({ kind: 'agent', tools: ['coding.run'] }).includes('coding.run'), false);
});

test('A failed or timed-out machine is still destroyed', async () => {
  const failing = fakeBackend();
  failing.backend.startJob = async () => {
    throw new Error('backend-down');
  };
  await assert.rejects(
    createCodingRuns(failing.backend, configuration, fakeServices().services).run(context(), call),
    /backend-down/,
  );
  assert.equal(failing.calls.at(-1)[0], 'destroy');

  const slow = fakeBackend({ finish: { state: 'timed-out' } });
  const result = await createCodingRuns(slow.backend, configuration, fakeServices().services).run(context(), call);
  assert.equal(result.status, 'timed-out');
  assert.equal(slow.calls.at(-1)[0], 'destroy');
  const [, started] = slow.calls.find(([name]) => name === 'startJob');
  assert.ok(Date.parse(started.deadline) - Date.now() <= 30 * 60 * 1000);
});

test('An agent stopped by its own time limit reports timed-out with the work so far', async () => {
  const { backend } = fakeBackend({ stdout: summary({ exitCode: 124, log: 'Terminated' }) });
  const result = await createCodingRuns(backend, configuration, fakeServices().services).run(context(), call);
  assert.equal(result.status, 'timed-out');
  assert.deepEqual(result.files, ['src/a.ts']);
});

test('Only a 16 KiB slice of the diff is shown; the whole diff is kept for the chat file', async () => {
  const diff = 'x'.repeat(20000);
  const { backend } = fakeBackend({ stdout: summary({ diff }) });
  const result = await createCodingRuns(backend, configuration, fakeServices().services).run(context(), call);
  assert.equal(result.diff.length, 16 * 1024);
  assert.equal(result.diffTruncated, true);
  assert.equal(result.fullDiff, diff);
});

test('Calls reject unsafe repositories and branches', () => {
  const parse = value => codingRunCallSchema.safeParse({ ...call, ...value }).success;
  assert.equal(parse({}), true);
  assert.equal(parse({ branch: 'feature/x-1' }), true);
  for (const repository of ['octo', 'octo/..', '-x/app', 'octo/app/extra', 'https://github.com/octo/app'])
    assert.equal(parse({ repository }), false, repository);
  for (const branch of ['--upload-pack=x', 'a..b', 'a b', '/x', 'x.lock'])
    assert.equal(parse({ branch }), false, branch);
  assert.equal(parse({ agent: 'gemini' }), false);
});

test('The run script clones, runs the agent and reports its message, files and diff', t => {
  const root = mkdtempSync(join(import.meta.dirname, '.coding-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const origin = join(root, 'octo', 'app.git');
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'seed');
  git(root, 'clone', '-q', '--bare', seed, origin);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const tool = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // The fake agent edits one file and adds another, and echoes its task back as the final message.
  tool(
    'claude',
    `task=$(cat); echo two >> a.txt; echo new > b.txt; printf '{"result":%s}' "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "done: $task")"`,
  );
  tool('timeout', 'shift 2; exec "$@"');
  const work = join(root, 'work');
  mkdirSync(work);
  const run = spawnSync(
    'bash',
    ['-c', codingRunScript('claude-code'), 'coding-run', 'octo/app', 'it\'s "quoted" $(true)', '', 'claude-code', '60'],
    {
      cwd: work,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.${root}/.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/',
      },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const line = run.stdout.split('\n').find(item => item.startsWith('TULIPFARM_CODING_RUN '));
  const result = JSON.parse(line.slice('TULIPFARM_CODING_RUN '.length));
  assert.equal(result.stage, 'done');
  assert.equal(result.exitCode, 0);
  assert.equal(result.message, `done: it's "quoted" $(true)`);
  assert.deepEqual(result.files, ['a.txt', 'b.txt']);
  assert.match(result.diff, /\+two/);
  assert.match(result.diff, /new file mode/);
});

test('The run script reports a failed clone', t => {
  const root = mkdtempSync(join(import.meta.dirname, '.coding-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = spawnSync(
    'bash',
    ['-c', codingRunScript('codex'), 'coding-run', 'octo/missing', 'task', 'main', 'codex', '60'],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.${root}/.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/',
      },
    },
  );
  const line = run.stdout.split('\n').find(item => item.startsWith('TULIPFARM_CODING_RUN '));
  const result = JSON.parse(line.slice('TULIPFARM_CODING_RUN '.length));
  assert.equal(result.stage, 'clone');
  assert.notEqual(result.log, '');
});
