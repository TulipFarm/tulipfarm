import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executionPathSchema, executionProfileSupported, executionSecretsSchema } from '@tulipfarm/execution-contract';
import { executionConfiguration, ExecutionConfigurationError } from '../dist/execution.js';

const policy = () => ({
  version: 1,
  baseRevision: 'a'.repeat(64),
  defaultProfile: 'small',
  profiles: [{ id: 'small', resources: { kind: 'limited', cpuMillis: 500, memoryMiB: 1024, diskBytes: 1048576 } }],
  network: 'public-only',
  idleTimeoutSeconds: 300,
  limits: {
    jobTimeoutSeconds: 30,
    queueTimeoutSeconds: 5,
    stopGraceSeconds: 2,
    checkpointIntervalSeconds: 1,
    workspaceConcurrency: 1,
    deploymentConcurrency: 2,
    workspaceStorageBytes: 1048576,
    fileBytes: 65536,
    fileCount: 32,
    outputBytes: 8192,
    jobBudgetPicoUsd: '0',
  },
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'execution-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'policy.json');
  return {
    directory,
    file,
    read(value, mode = 'extension') {
      writeFileSync(file, JSON.stringify(value));
      return executionConfiguration({
        TULIPFARM_EXECUTION_BACKEND: mode,
        TULIPFARM_EXECUTION_POLICY_FILE: file,
      });
    },
  };
}

test('execution defaults off without reading the policy file', () => {
  assert.deepEqual(executionConfiguration({}), { mode: 'off' });
  assert.deepEqual(executionConfiguration({ TULIPFARM_EXECUTION_POLICY_FILE: '/does-not-exist' }), { mode: 'off' });
  assert.throws(
    () => executionConfiguration({ TULIPFARM_EXECUTION_BACKEND: 'unknown' }),
    /Invalid TULIPFARM_EXECUTION_BACKEND/,
  );
  assert.throws(
    () => executionConfiguration({ TULIPFARM_EXECUTION_BACKEND: 'local' }),
    /TULIPFARM_EXECUTION_POLICY_FILE is required/,
  );
});

test('execution policy reads reject missing, non-file, malformed and oversized input without echoing it', t => {
  const { directory, file } = fixture(t);
  const read = path =>
    executionConfiguration({
      TULIPFARM_EXECUTION_BACKEND: 'extension',
      TULIPFARM_EXECUTION_POLICY_FILE: path,
    });
  const rejected = action =>
    assert.throws(action, {
      name: 'ExecutionConfigurationError',
      message: 'Could not read TULIPFARM_EXECUTION_POLICY_FILE',
    });
  rejected(() => read(file));
  rejected(() => read(directory));
  writeFileSync(file, 'private-input-is-not-json');
  rejected(() => read(file));
  writeFileSync(file, ' '.repeat(256 * 1024 + 1));
  rejected(() => read(file));
});

test('execution policy revision tracks content and mode, not JSON formatting', t => {
  const { read, file } = fixture(t);
  const first = read(policy());
  writeFileSync(file, JSON.stringify(policy(), null, 2));
  const formatted = executionConfiguration({
    TULIPFARM_EXECUTION_BACKEND: 'extension',
    TULIPFARM_EXECUTION_POLICY_FILE: file,
  });
  assert.equal(formatted.policyRevision, first.policyRevision);
  assert.notEqual(read(policy(), 'docker').policyRevision, first.policyRevision);
  const changed = policy();
  changed.limits.jobTimeoutSeconds++;
  assert.notEqual(read(changed).policyRevision, first.policyRevision);
  assert.deepEqual(first.policy, policy());
});

test('direct execution accepts only shared resources and inherited network', t => {
  const { read } = fixture(t);
  const direct = policy();
  direct.profiles = [{ id: 'small', resources: { kind: 'shared' } }];
  direct.network = 'inherited';
  assert.equal(read(direct, 'local').mode, 'local');
  assert.throws(() => read(policy(), 'local'), /does not match/);
  for (const mode of ['docker', 'extension']) {
    assert.equal(read(policy(), mode).mode, mode);
    assert.throws(() => read(direct, mode), /does not match/);
    assert.throws(() => read({ ...policy(), network: 'inherited' }, mode), /does not match/);
  }
  assert.throws(() => read({ ...direct, network: 'public-only' }, 'local'), /does not match/);
});

test('execution policy rejects ambiguous profiles and inconsistent or unsafe limits', t => {
  const { read } = fixture(t);
  const changes = [
    value => {
      value.defaultProfile = 'missing';
    },
    value => {
      value.profiles.push(value.profiles[0]);
    },
    value => {
      value.profiles[0].resources.cpuMillis = 0.5;
    },
    value => {
      value.limits.workspaceConcurrency = 3;
    },
    value => {
      value.limits.fileBytes = value.limits.workspaceStorageBytes + 1;
    },
    value => {
      value.limits.checkpointIntervalSeconds = value.limits.jobTimeoutSeconds + 1;
    },
    value => {
      value.limits.jobTimeoutSeconds = 0;
    },
    value => {
      value.limits.outputBytes = Number.MAX_SAFE_INTEGER + 1;
    },
    value => {
      value.limits.jobBudgetPicoUsd = '-1';
    },
    value => {
      delete value.limits.queueTimeoutSeconds;
    },
    value => {
      value.extra = true;
    },
  ];
  for (const change of changes) {
    const value = policy();
    change(value);
    assert.throws(() => read(value), ExecutionConfigurationError);
  }
});

test('working paths reject traversal, absolute paths and control characters', () => {
  assert.equal(executionPathSchema.parse('images/frame 1.png'), 'images/frame 1.png');
  for (const path of [
    '',
    '/etc/passwd',
    '../other',
    'a/../b',
    './a',
    'a//b',
    'a/',
    'C:/a',
    'a\\b',
    'a\nb',
    'a\0b',
    'a\x7fb',
  ]) {
    assert.equal(executionPathSchema.safeParse(path).success, false, JSON.stringify(path));
  }
});

test('a profile template must be one the backend lists, and secrets need unique names and variables', () => {
  const resources = { kind: 'limited', cpuMillis: 1000, memoryMiB: 512, diskBytes: 1048576 };
  const descriptor = {
    capabilities: { secrets: true },
    profiles: [{ id: 'small', resources }],
    templates: ['codex'],
  };
  assert.equal(executionProfileSupported({ id: 'small', resources, template: 'codex' }, descriptor), true);
  assert.equal(executionProfileSupported({ id: 'small', resources, template: 'copilot' }, descriptor), false);
  assert.equal(
    executionProfileSupported({ id: 'small', resources, template: 'codex' }, { ...descriptor, templates: undefined }),
    false,
  );
  const secret = { name: 'plan', value: 'v', env: 'TOKEN', hosts: ['api.example.com', '*.example.com'] };
  assert.equal(executionSecretsSchema.safeParse([secret]).success, true);
  assert.equal(executionSecretsSchema.safeParse([secret, { ...secret, env: 'OTHER' }]).success, false);
  assert.equal(executionSecretsSchema.safeParse([secret, { ...secret, name: 'git' }]).success, false);
  assert.equal(executionSecretsSchema.safeParse([{ ...secret, hosts: ['https://example.com'] }]).success, false);
  assert.equal(executionSecretsSchema.safeParse([{ ...secret, format: 'Bearer' }]).success, false);
});
