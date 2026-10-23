import assert from 'node:assert/strict';
import test from 'node:test';
import { githubRuntimeConfiguration } from '../dist/configuration.js';

const configured = {
  NODE_ENV: 'production',
  GITHUB_OAUTH_CLIENT_ID: 'local-client',
  GITHUB_OAUTH_CLIENT_SECRET: 'local-secret',
  GITHUB_OAUTH_REDIRECT_URI: 'https://app.example.test/github/callback',
  GITHUB_MCP_READ_BINDINGS: '[]',
  GITHUB_MCP_WRITE_BINDINGS: '[]',
};

test('production GitHub is disabled or complete', () => {
  assert.deepEqual(githubRuntimeConfiguration({ NODE_ENV: 'production' }), {
    oauth: null,
    readBindings: [],
    writeBindings: [],
  });
  assert.equal(githubRuntimeConfiguration(configured).oauth.redirectUri, 'https://app.example.test/github/callback');
  for (const key of Object.keys(configured).filter(key => key !== 'NODE_ENV')) {
    const partial = { ...configured };
    delete partial[key];
    assert.throws(() => githubRuntimeConfiguration(partial));
    assert.throws(() => githubRuntimeConfiguration({ ...configured, [key]: '' }));
  }
});

test('orphaned and unmapped bindings fail closed without disclosing their values', () => {
  for (const key of ['GITHUB_MCP_READ_BINDINGS', 'GITHUB_MCP_WRITE_BINDINGS']) {
    assert.throws(() => githubRuntimeConfiguration({ [key]: '[]' }), /require OAuth/);
    for (const value of [
      'sensitive-invalid-json',
      JSON.stringify([{ operation: 'unknown', name: 'untrusted', contractDigest: 'a'.repeat(64) }]),
    ]) {
      assert.throws(
        () => githubRuntimeConfiguration({ ...configured, [key]: value }),
        error => !error.message.includes(value),
      );
    }
  }
});
