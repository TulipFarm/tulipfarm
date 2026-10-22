import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleLifecycleError } from '@tulipfarm/google-workspace/operations';
import { GoogleWorkspaceError } from '@tulipfarm/google-workspace/contracts';
import { googleToolError } from '../src/google-tools.ts';

test('a refused in-place Google update requires agreement before making a reusable copy', () => {
  const result = googleToolError(new GoogleLifecycleError('operation-unguarded-update'));
  assert.equal(result.error, 'operation-unguarded-update');
  assert.match(result.message, /refused/);
  assert.match(result.message, /Ask the person before replacing an edit with a copy/);
  assert.match(result.message, /If they agree, create it with drive\.files\.copy/);
  assert.match(result.message, /same copy for later edits/);
});

test('other Google errors keep the bare code', () => {
  assert.deepEqual(googleToolError(new GoogleLifecycleError('operation-target-stale')), {
    provider: 'google-workspace',
    untrusted: true,
    error: 'operation-target-stale',
  });
});

test('a Sheets write refused for a missing Drive scope tells the owner to grant Google Drive access', () => {
  const result = googleToolError(
    new GoogleWorkspaceError('insufficient-scope', ['https://www.googleapis.com/auth/drive']),
  );
  assert.equal(result.error, 'insufficient-scope');
  assert.equal(
    result.message,
    'The task owner has not granted Google Drive access. Ask them to open Integrations, choose Google Drive, and select Grant access, then propose again. Sheets edits on a created or copied spreadsheet read its Drive version first, so they need Google Drive access too.',
  );
});

test('an insufficient-scope error from the provider carries no recovery guess', () => {
  assert.deepEqual(googleToolError(new GoogleWorkspaceError('insufficient-scope')), {
    provider: 'google-workspace',
    untrusted: true,
    error: 'insufficient-scope',
  });
});
