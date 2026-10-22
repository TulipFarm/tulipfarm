import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mcpCredentialCipher } from '../dist/credentials.js';
import {
  canonicalJson,
  endpointIdentity,
  toolRevision,
  toolCompatibility,
  validateArguments,
  rejectReflectedSecrets,
} from '../dist/validation.js';

test('MCP encryption binds workspace, integration, version, purpose and rejects unrelated keyrings', () => {
  const cipher = mcpCredentialCipher({ activeKeyId: 'one', keys: { one: 'ab'.repeat(32) } });
  const binding = { workspaceId: randomUUID(), integrationId: randomUUID(), version: 1, purpose: 'credential' };
  const encrypted = cipher.encrypt(binding, 'sensitive-test-token');
  assert.equal(cipher.decrypt(binding, encrypted), 'sensitive-test-token');
  assert.ok(!JSON.stringify(encrypted).includes('sensitive-test-token'));
  for (const changed of [
    { workspaceId: randomUUID() },
    { integrationId: randomUUID() },
    { version: 2 },
    { purpose: 'oauth' },
  ])
    assert.throws(() => cipher.decrypt({ ...binding, ...changed }, encrypted), /credential-unavailable/);
  assert.throws(
    () => mcpCredentialCipher({ activeKeyId: 'two', keys: { two: 'cd'.repeat(32) } }).decrypt(binding, encrypted),
    /credential-unavailable/,
  );
});

test('endpoint identities reject ambiguous and credential-bearing endpoints', () => {
  assert.equal(endpointIdentity('https://Example.com:443/mcp'), 'https://example.com/mcp');
  for (const endpoint of [
    'http://example.com/mcp',
    'https://user:secret@example.com/mcp',
    'https://example.com/?token=secret',
    'https://example.com/#secret',
    'https://127.0.0.1/mcp',
    'https://[::1]/mcp',
    'https://example.com:444/mcp',
    'https://localhost/mcp',
  ])
    assert.throws(() => endpointIdentity(endpoint), /invalid-input/);
});

test('versioned contracts detect description and metadata drift, validate original arguments and reject unsafe schema keywords', () => {
  const tool = {
    name: 'write',
    description: 'Write a record',
    inputSchema: {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
      additionalProperties: false,
    },
  };
  assert.equal(toolCompatibility(tool), null);
  validateArguments(tool, { count: 1 });
  assert.throws(() => validateArguments(tool, { count: '1' }), /invalid-input/);
  assert.notEqual(toolRevision(tool), toolRevision({ ...tool, description: 'Read a record' }));
  assert.notEqual(toolRevision(tool), toolRevision({ ...tool, annotations: { readOnlyHint: true } }));
  for (const schema of [
    { $ref: 'https://example.com/schema' },
    { type: 'string', pattern: '(a+)+$' },
    { type: 'string', format: 'email' },
    { type: 'array', uniqueItems: true },
  ])
    assert.equal(
      toolCompatibility({ ...tool, inputSchema: { type: 'object', properties: { value: schema } } }),
      'unsupported-schema',
    );
  assert.equal(canonicalJson({ z: 1, a: { b: 2, a: 3 } }), '{"a":{"a":3,"b":2},"z":1}');
});

test('reflected secrets are rejected in literal, encoded, and base64 results', () => {
  const credential = { kind: 'bearer', token: 'secret/value+42' };
  for (const value of [
    credential.token,
    encodeURIComponent(credential.token),
    Buffer.from(credential.token).toString('base64'),
  ])
    assert.throws(() => rejectReflectedSecrets({ text: value }, credential), /credential-unavailable/);
});
