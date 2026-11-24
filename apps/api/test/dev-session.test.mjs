import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDevPlans, devPlanSources } from '../src/dev-plans.ts';
import { devSessionsAllowed, safeRedirectPath } from '../src/dev-session.ts';

test('dev sessions stay local and without real email', () => {
  assert.equal(devSessionsAllowed({ NODE_ENV: 'development', HOST: '127.0.0.1' }), true);
  assert.equal(devSessionsAllowed({ NODE_ENV: 'production', HOST: '127.0.0.1' }), false);
  assert.equal(devSessionsAllowed({ NODE_ENV: 'development', HOST: '0.0.0.0' }), false);
  assert.equal(
    devSessionsAllowed({ NODE_ENV: 'development', ACS_CONNECTION_STRING: 'endpoint=https://acs.test/' }),
    false,
  );
  assert.equal(devSessionsAllowed({ NODE_ENV: 'development', SMTP_HOST: 'smtp.example.test' }), false);
  assert.equal(devSessionsAllowed({ NODE_ENV: 'development', EMAIL_PROVIDER: 'smtp' }), false);
});

test('dev session redirects stay on the web origin', () => {
  assert.equal(safeRedirectPath('/seed-rich/tables?x=1#a'), '/seed-rich/tables?x=1#a');
  for (const value of [undefined, 'https://evil.test', '//evil.test', '/\\evil.test', 'seed-rich'])
    assert.equal(safeRedirectPath(value), '/');
});

const local = { NODE_ENV: 'development', HOST: '127.0.0.1' };
const quiet = { warn() {} };

function fakePlan(connected = false) {
  const calls = [];
  return {
    calls,
    async status(workspaceId, userId) {
      calls.push(['status', workspaceId, userId]);
      return { connections: connected ? [{ state: 'connected' }] : [] };
    },
    async connectToken(workspaceId, userId, token) {
      calls.push(['connect', workspaceId, userId, token]);
      connected = true;
    },
  };
}

test('dev plan tokens come from the machine file, with the process env taking precedence', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'dev-plans-')), 'dev.env');
  await writeFile(
    file,
    'TULIPFARM_DEV_PLAN_COPILOT_TOKEN_COMMAND=printf gho_x\nTULIPFARM_DEV_PLAN_CLAUDE_TOKEN=from-file\n',
  );
  const sources = devPlanSources({ TULIPFARM_DEV_ENV_FILE: file, TULIPFARM_DEV_PLAN_CLAUDE_TOKEN: 'from-env' });
  assert.deepEqual(Object.fromEntries(sources), {
    claude: { token: 'from-env' },
    copilot: { command: 'printf gho_x' },
  });
  assert.equal(devPlanSources({ TULIPFARM_DEV_ENV_FILE: join(file, '..', 'missing.env') }).size, 0);
});

test('dev plans connect a member once from a command, and leave a working connection alone', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'dev-plans-')), 'missing.env');
  const env = { ...local, TULIPFARM_DEV_ENV_FILE: file, TULIPFARM_DEV_PLAN_COPILOT_TOKEN_COMMAND: 'printf gho_dev' };
  const copilot = fakePlan();
  const plans = createDevPlans({ copilot, claude: null }, quiet, env);
  await plans.ensure('w1', 'u1');
  await plans.ensure('w1', 'u1');
  assert.deepEqual(copilot.calls, [
    ['status', 'w1', 'u1'],
    ['connect', 'w1', 'u1', 'gho_dev'],
  ]);

  const working = fakePlan(true);
  await createDevPlans({ copilot: working }, quiet, env).ensure('w1', 'u1');
  assert.deepEqual(working.calls, [['status', 'w1', 'u1']]);
});

test('dev plans stay off outside local development or without a token', async () => {
  const token = { TULIPFARM_DEV_PLAN_COPILOT_TOKEN: 'gho_dev', TULIPFARM_DEV_ENV_FILE: '/nonexistent/dev.env' };
  assert.equal(createDevPlans({ copilot: fakePlan() }, quiet, { ...token, NODE_ENV: 'production' }), undefined);
  assert.equal(
    createDevPlans({ copilot: fakePlan() }, quiet, { ...local, TULIPFARM_DEV_ENV_FILE: '/nonexistent/dev.env' }),
    undefined,
  );
  assert.equal(createDevPlans({ copilot: null }, quiet, { ...local, ...token }), undefined);
});

test('a failed dev plan connection waits before trying again', async () => {
  const warnings = [];
  const plan = {
    ...fakePlan(),
    connectToken: async () => {
      throw new Error('token-rejected');
    },
  };
  let statuses = 0;
  plan.status = async () => (statuses++, { connections: [] });
  const env = { ...local, TULIPFARM_DEV_ENV_FILE: '/nonexistent/dev.env', TULIPFARM_DEV_PLAN_COPILOT_TOKEN: 'gho_dev' };
  const plans = createDevPlans(
    { copilot: plan },
    { warn: (details, message) => warnings.push([details, message]) },
    env,
  );
  await plans.ensure('w1', 'u1');
  await plans.ensure('w1', 'u1');
  assert.equal(statuses, 1);
  assert.deepEqual(warnings, [
    [{ provider: 'copilot', workspaceId: 'w1', error: 'token-rejected' }, 'Development plan connection failed'],
  ]);
});
