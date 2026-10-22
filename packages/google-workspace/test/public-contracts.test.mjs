import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { googleCallbackOutcomeSchema, googleCallbackResultSchema } from '../src/callback-contracts.ts';
import { googleCallbackResultSchema as publicCallbackSchema } from '../src/public-contracts.ts';

test('standalone callback contracts preserve public exports, outcomes, and strict input checks', () => {
  assert.equal(googleCallbackResultSchema, publicCallbackSchema);
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  for (const outcome of googleCallbackOutcomeSchema.options) {
    assert.deepEqual(googleCallbackResultSchema.parse({ outcome }), { outcome });
    assert.deepEqual(googleCallbackResultSchema.parse({ outcome, workspaceId }), { outcome, workspaceId });
  }
  for (const value of [
    { outcome: 'unknown' },
    { outcome: 'connected', workspaceId: 'not-a-uuid' },
    { outcome: 'connected', returnUrl: 'https://evil.test' },
    { workspaceId },
  ]) {
    assert.equal(googleCallbackResultSchema.safeParse(value).success, false);
  }
});

test('public Google contracts parse browser data without server modules, Buffer or process', () => {
  const child = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      '--input-type=module',
      '--eval',
      `
    import { registerHooks } from 'node:module';
    const output = process.stdout;
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith('node:') || specifier === 'pg' || specifier === '@tulipfarm/access' || specifier.startsWith('@tulipfarm/workspace-storage')) throw new Error('server module reached public contracts: ' + specifier);
      return next(specifier, context);
    } });
    globalThis.Buffer = undefined;
    globalThis.process = undefined;
    const contracts = await import('@tulipfarm/google-workspace/public-contracts');
    output.write(JSON.stringify({
      status: contracts.googleStatusSchema.parse({ status: 'disconnected' }),
      availability: contracts.googleAvailabilitySchema.parse({ configured: false }),
      callback: contracts.googleCallbackResultSchema.parse({ outcome: 'consent-denied' }),
      upload: contracts.proposalRequestSchema.parse({ commandId: '11111111-1111-4111-8111-111111111111', operation: { kind: 'drive.files.upload', mimeType: 'text/plain', contentBase64: 'Zg==' } }),
      page: contracts.googleProposalListSchema.parse({ proposals: [], nextCursor: null }),
      invalidOutcome: contracts.googleCallbackResultSchema.safeParse({ outcome: 'private-provider-error' }).success,
      redirectInput: contracts.googleCallbackResultSchema.safeParse({ outcome: 'connected', returnUrl: 'https://evil.test' }).success,
      query: contracts.googleProposalListQuerySchema.parse({}),
      heartbeat: contracts.heartbeatSettingsSchema.parse({ enabled: true, cadenceMinutes: 1, query: 'is:unread', labelId: null, instructions: 'Summarize.' }),
      retry: contracts.heartbeatRetrySchema.parse({ commandId: '11111111-1111-4111-8111-111111111111', itemId: '22222222-2222-4222-8222-222222222222', revision: 1 }),
      retryResult: contracts.heartbeatRetryResultSchema.parse({ accepted: true }),
    }));
  `,
    ],
    { encoding: 'utf8', cwd: new URL('..', import.meta.url) },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    status: { status: 'disconnected' },
    availability: { configured: false },
    callback: { outcome: 'consent-denied' },
    upload: {
      commandId: '11111111-1111-4111-8111-111111111111',
      operation: { kind: 'drive.files.upload', mimeType: 'text/plain', contentBase64: 'Zg==' },
    },
    page: { proposals: [], nextCursor: null },
    invalidOutcome: false,
    redirectInput: false,
    query: { limit: 25 },
    heartbeat: { enabled: true, cadenceMinutes: 1, query: 'is:unread', labelId: null, instructions: 'Summarize.' },
    retry: {
      commandId: '11111111-1111-4111-8111-111111111111',
      itemId: '22222222-2222-4222-8222-222222222222',
      revision: 1,
    },
    retryResult: { accepted: true },
  });
});
