import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { integrationGrantsSchema, repositorySchema } from '../src/contracts.ts';
import { credentialCipher, integrationCredentialKeyring } from '../src/credentials.ts';
import { fetchIssue } from '../src/github.ts';

test('grants require explicit read and repositories reject URL path injection', () => {
  const teamId = randomUUID();
  assert.deepEqual(
    integrationGrantsSchema.parse({
      expectedGrantsVersion: 1,
      grants: [{ teamId, permissions: ['read', 'manage'] }],
      sourceGrants: [],
    }).grants[0].permissions,
    ['read', 'manage'],
  );
  assert.equal(
    integrationGrantsSchema.safeParse({
      expectedGrantsVersion: 1,
      grants: [{ teamId, permissions: ['manage'] }],
      sourceGrants: [],
    }).success,
    false,
  );
  for (const expectedGrantsVersion of [undefined, 0, -1, 1.5, 2147483647])
    assert.equal(
      integrationGrantsSchema.safeParse({ expectedGrantsVersion, grants: [], sourceGrants: [] }).success,
      false,
    );
  for (const repo of ['..', '.', 'a/b', 'a?b', 'a#b'])
    assert.equal(repositorySchema.safeParse({ id: randomUUID(), owner: 'test', repo }).success, false);
});

test('investigation grants are separate, explicit and cannot smuggle legacy or write permissions', () => {
  const policy = { expectedGrantsVersion: 1, grants: [], sourceGrants: [] };
  const grant = { teamId: randomUUID(), sourceId: randomUUID(), permissions: ['github.code.read'] };
  assert.deepEqual(integrationGrantsSchema.parse(policy), policy);
  assert.deepEqual(integrationGrantsSchema.parse({ ...policy, investigationGrants: [grant] }).investigationGrants, [
    grant,
  ]);
  for (const permissions of [
    [],
    ['github.issue.read'],
    ['github.code.write'],
    ['github.code.read', 'github.code.read'],
  ]) {
    assert.equal(
      integrationGrantsSchema.safeParse({ ...policy, investigationGrants: [{ ...grant, permissions }] }).success,
      false,
    );
  }
});

test('AES-GCM authenticates workspace, integration, generation and supports previous keys', () => {
  const keyring = integrationCredentialKeyring({
    INTEGRATION_CREDENTIAL_KEY_ID: 'old',
    INTEGRATION_CREDENTIAL_KEY: 'ab'.repeat(32),
  });
  const old = credentialCipher(keyring);
  const workspace = randomUUID();
  const integration = randomUUID();
  const envelope = old.encrypt(workspace, integration, 1, 'private-token');
  const next = credentialCipher({ activeKeyId: 'new', keys: { ...keyring.keys, new: 'cd'.repeat(32) } });
  assert.equal(next.decrypt(workspace, integration, 1, envelope), 'private-token');
  assert.equal(next.decrypt(workspace.toUpperCase(), integration.toUpperCase(), 1, envelope), 'private-token');
  for (const context of [
    [randomUUID(), integration, 1],
    [workspace, randomUUID(), 1],
    [workspace, integration, 2],
  ])
    assert.throws(() => next.decrypt(...context, envelope), /credential-unavailable/);
  assert.equal(JSON.stringify(envelope).includes('private-token'), false);
  assert.throws(
    () =>
      credentialCipher({ activeKeyId: 'new', keys: { new: 'cd'.repeat(32) } }).decrypt(
        workspace,
        integration,
        1,
        envelope,
      ),
    /credential-unavailable/,
  );
});

test('provider returns only safe issue fields and refuses PR, redirects, oversized responses and thrown secrets', async () => {
  const input = { owner: 'test', repo: 'repo', issueNumber: 17, token: 'private-token' };
  const issue = { number: 17, title: 'private-token', body: 'body', state: 'open' };
  assert.deepEqual(await fetchIssue(input, async () => new Response(JSON.stringify(issue))), {
    number: 17,
    title: '[redacted]',
    body: 'body',
    state: 'open',
    url: 'https://github.com/test/repo/issues/17',
  });
  for (const provider of [
    async () => new Response(JSON.stringify({ ...issue, pull_request: {} })),
    async () => new Response('', { status: 301, headers: { Location: 'https://example.com' } }),
    async () => new Response('a'.repeat(262145)),
    async () => {
      throw new Error(input.token);
    },
  ])
    await assert.rejects(
      fetchIssue(input, provider),
      error => error.message === 'Integration operation provider-failed',
    );
});
