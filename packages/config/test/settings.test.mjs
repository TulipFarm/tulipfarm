import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { secretSettingNames, settingGroups, settings, settingsByName } from '../dist/settings.js';
import { SecretFileError, loadSecretFiles } from '../dist/secret-files.js';
import { renderEnvExample, replaceGeneratedBlock } from '../dist/settings-docs.js';

test('the settings registry declares each variable once with documented metadata', () => {
  assert.equal(settingsByName.size, settings.length);
  for (const setting of settings) {
    assert.match(setting.name, /^[A-Z][A-Z0-9_]*$/);
    assert.ok(settingGroups.includes(setting.group), setting.name);
    assert.ok(setting.services.length > 0 && setting.description.length > 0, setting.name);
    assert.equal(
      setting.name.endsWith('_FILE') && settingsByName.has(setting.name.slice(0, -5)) && setting.secret,
      false,
      `${setting.name} collides with secret-file loading`,
    );
    if (setting.selfHost)
      assert.ok(
        setting.services.includes('compose') || ['api', 'worker'].some(service => setting.services.includes(service)),
        setting.name,
      );
  }
  for (const name of [
    'BETTER_AUTH_SECRET',
    'WORKSPACE_RUNTIME_KEY',
    'INTEGRATION_CREDENTIAL_PREVIOUS_KEYS',
    'DATABASE_URL',
  ])
    assert.ok(secretSettingNames.includes(name), name);
  for (const name of ['POSTGRES_PASSWORD', 'WORKSPACE_RUNTIME_KEY_ID'])
    assert.equal(secretSettingNames.includes(name), false, name);
});

test('secret files fill secret variables and strip trailing newlines', () => {
  const directory = mkdtempSync(join(import.meta.dirname, '.secret-files-'));
  try {
    const file = join(directory, 'value');
    writeFileSync(file, 'file-value\n\n');
    const env = {
      TEST_SECRET_FILE: file,
      SAME_SECRET: 'file-value',
      SAME_SECRET_FILE: file,
      EMPTY_SECRET: '',
      EMPTY_SECRET_FILE: file,
      PLAIN: 'kept',
    };
    assert.deepEqual(loadSecretFiles(env, ['TEST_SECRET', 'SAME_SECRET', 'EMPTY_SECRET', 'UNSET_SECRET']), [
      'TEST_SECRET',
      'SAME_SECRET',
      'EMPTY_SECRET',
    ]);
    assert.equal(env.TEST_SECRET, 'file-value');
    assert.equal(env.SAME_SECRET, 'file-value');
    assert.equal(env.EMPTY_SECRET, 'file-value');
    assert.equal(env.PLAIN, 'kept');
    assert.equal(env.UNSET_SECRET, undefined);
    const windows = join(directory, 'windows');
    writeFileSync(windows, 'line-one\nline-two\r\n');
    const multiline = { MULTI_FILE: windows };
    loadSecretFiles(multiline, ['MULTI']);
    assert.equal(multiline.MULTI, 'line-one\nline-two');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('secret files reject conflicts and unreadable paths without echoing values', () => {
  const read = () => 'from-file';
  assert.throws(
    () => loadSecretFiles({ TOKEN: 'from-env', TOKEN_FILE: '/run/secrets/token' }, ['TOKEN'], read),
    error =>
      error instanceof SecretFileError &&
      error.variable === 'TOKEN' &&
      !error.message.includes('from-env') &&
      !error.message.includes('from-file'),
  );
  assert.throws(
    () =>
      loadSecretFiles({ TOKEN_FILE: '/missing/token' }, ['TOKEN'], () => {
        throw new Error('ENOENT');
      }),
    error => error instanceof SecretFileError && error.message.includes('/missing/token'),
  );
  const env = {
    BETTER_AUTH_SECRET_FILE: '/run/secrets/auth',
    NOT_SECRET_FILE: '/run/secrets/other',
  };
  assert.deepEqual(
    loadSecretFiles(env, undefined, () => 'auth'),
    ['BETTER_AUTH_SECRET'],
  );
  assert.equal(env.NOT_SECRET, undefined);
});

test('generated documents come from the registry', () => {
  const example = renderEnvExample();
  for (const setting of settings.filter(entry => entry.selfHost))
    assert.match(example, new RegExp(`^(# )?${setting.name}=`, 'm'));
  assert.equal(
    replaceGeneratedBlock('a\n<!-- BEGIN GENERATED: x -->\nold\n<!-- END GENERATED: x -->\nb', 'x', 'new'),
    'a\n<!-- BEGIN GENERATED: x -->\nnew\n<!-- END GENERATED: x -->\nb',
  );
  assert.throws(() => replaceGeneratedBlock('no markers', 'x', 'new'), /Generated block x is missing/);
});
