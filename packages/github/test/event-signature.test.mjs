import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  githubWebhookBodyLimit,
  githubWebhookSignature,
  GitHubWebhookError,
  readGitHubAppDelivery,
} from '../src/event-signature.ts';

const secret = 'fixture-server-managed-signing-secret';
const headers = raw => ({
  'x-hub-signature-256': `sha256=${githubWebhookSignature(secret, raw)}`,
  'x-github-delivery': randomUUID(),
  'x-github-event': 'pull_request',
});
const failure = code => error => error instanceof GitHubWebhookError && error.code === code;

test('App delivery proof authenticates exact bytes before parsing metadata or JSON', () => {
  const raw = Buffer.from('{ "title": "A 🪷 PR" }'),
    signed = headers(raw);
  const result = readGitHubAppDelivery(secret, raw, signed);
  assert.deepEqual(result, {
    deliveryId: signed['x-github-delivery'],
    event: 'pull_request',
    bodyDigest: createHash('sha256').update(raw).digest('hex'),
    body: { title: 'A 🪷 PR' },
  });
  assert.throws(
    () => readGitHubAppDelivery(secret, Buffer.from(JSON.stringify(result.body)), signed),
    failure('signature-invalid'),
  );
  assert.throws(
    () => readGitHubAppDelivery('different-server-managed-signing-secret', raw, signed),
    failure('signature-invalid'),
  );
  assert.throws(() => readGitHubAppDelivery(secret, Buffer.from('not-json'), {}), failure('signature-invalid'));
  assert.throws(
    () => readGitHubAppDelivery(secret, raw, { ...signed, 'x-hub-signature-256': [signed['x-hub-signature-256']] }),
    failure('signature-invalid'),
  );
  assert.throws(
    () => readGitHubAppDelivery(secret, raw, { ...signed, 'x-hub-signature-256': 'sha256=bad' }),
    failure('signature-invalid'),
  );
});

test('valid signatures do not excuse malformed headers, JSON or UTF-8', () => {
  const raw = Buffer.from('{}'),
    signed = headers(raw);
  assert.throws(
    () =>
      readGitHubAppDelivery('', raw, { ...signed, 'x-hub-signature-256': `sha256=${githubWebhookSignature('', raw)}` }),
    /Invalid GitHub App webhook secret/,
  );
  for (const patch of [
    { 'x-github-delivery': 'not-a-guid' },
    { 'x-github-delivery': [randomUUID(), randomUUID()] },
    { 'x-github-event': 'pull_request\ninjected' },
    { 'x-github-event': ['pull_request', 'issue_comment'] },
  ])
    assert.throws(() => readGitHubAppDelivery(secret, raw, { ...signed, ...patch }), failure('headers-invalid'));
  for (const malformed of [Buffer.from('{'), Buffer.from('[1]'), Buffer.from('null'), Buffer.from([0xff])]) {
    assert.throws(() => readGitHubAppDelivery(secret, malformed, headers(malformed)), failure('payload-invalid'));
  }
  assert.equal(readGitHubAppDelivery(secret, raw, { ...signed, 'x-github-event': 'ping' }).event, 'ping');
});

test('the App endpoint body cap is independent of the smaller generic workflow cap', () => {
  const raw = Buffer.alloc(githubWebhookBodyLimit, ' ');
  raw.write('{}');
  assert.deepEqual(readGitHubAppDelivery(secret, raw, headers(raw)).body, {});
  assert.throws(
    () => readGitHubAppDelivery(secret, Buffer.alloc(githubWebhookBodyLimit + 1), {}),
    failure('payload-too-large'),
  );
});

test('App delivery must come from this App when the App ID is known', () => {
  const raw = Buffer.from('{}'),
    signed = {
      ...headers(raw),
      'x-github-hook-installation-target-type': 'integration',
      'x-github-hook-installation-target-id': '5442409',
    };
  assert.equal(readGitHubAppDelivery(secret, raw, signed, '5442409').event, 'pull_request');
  for (const patch of [
    { 'x-github-hook-installation-target-id': '1' },
    { 'x-github-hook-installation-target-type': 'repository' },
    { 'x-github-hook-installation-target-id': undefined },
  ])
    assert.throws(
      () => readGitHubAppDelivery(secret, raw, { ...signed, ...patch }, '5442409'),
      failure('headers-invalid'),
    );
});
