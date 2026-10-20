import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  byteSize,
  deliveryOutcome,
  deliveryRun,
  webhookCurl,
  webhookInstructions,
  webhookPayload,
  webhookStatus,
} from '../src/features/workflows/webhook-status.ts';
import { githubWebhookSignature, webhookSignature } from '../../../packages/workflows/src/webhook-keys.ts';

const id = '00000000-0000-4000-8000-000000000001',
  older = '00000000-0000-4000-8000-000000000002';
const definition = trigger => ({
  version: 1,
  name: 'Webhook',
  trigger,
  steps: [{ id: 'copy', kind: 'transform', fields: {} }],
});
const workflow = (saved, active, { enabled = true, configured = true } = {}) => ({
  id,
  revision: id,
  activeRevision: active ? older : null,
  enabled,
  generation: 1,
  nextRunAt: null,
  definition: definition(saved),
  activeTrigger: active,
  webhookConfigured: configured,
});

test('webhook status follows the active trigger, not the saved one', () => {
  assert.deepEqual(webhookStatus(workflow({ kind: 'webhook' }, { kind: 'webhook' })), {
    visible: true,
    configured: true,
    receiving: true,
    endpoint: 'Receiving requests. Calls that use the current key start the active revision.',
    change: null,
  });
  assert.equal(
    webhookStatus(workflow({ kind: 'webhook' }, { kind: 'webhook' }, { configured: false })).endpoint,
    'Not receiving requests. Create a key to start accepting calls.',
  );
  assert.deepEqual(webhookStatus(workflow({ kind: 'manual' }, { kind: 'webhook' })), {
    visible: true,
    configured: true,
    receiving: true,
    endpoint: 'Receiving requests. Calls that use the current key start the active revision.',
    change: 'The saved revision uses a manual trigger. Activating it stops this endpoint and deletes the webhook key.',
  });
  assert.deepEqual(
    webhookStatus(workflow({ kind: 'webhook' }, { kind: 'interval', minutes: 5 }, { configured: false })),
    {
      visible: true,
      configured: false,
      receiving: false,
      endpoint:
        'Not receiving requests. The active revision uses a repeating trigger. Activate the saved revision to accept calls.',
      change: null,
    },
  );
  assert.equal(
    webhookStatus(workflow({ kind: 'webhook' }, null, { enabled: false, configured: false })).endpoint,
    'Not receiving requests. Activate the saved revision to accept calls.',
  );
  assert.deepEqual(webhookStatus(workflow({ kind: 'webhook' }, { kind: 'webhook' }, { enabled: false })), {
    visible: true,
    configured: true,
    receiving: false,
    endpoint: 'Not receiving requests. The workflow is disabled. Activate the saved revision to accept calls.',
    change: null,
  });
  assert.equal(
    webhookStatus(workflow({ kind: 'manual' }, { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' })).visible,
    false,
  );
});

test('curl example reads the key from the environment and generates the request ID', async () => {
  const url = `https://api.example.com/v1/workspaces/${older}/workflows/${id}/webhook`;
  const example = webhookCurl(url, undefined, 'bearer');
  assert.equal(
    example,
    [
      `curl -X POST '${url}' \\`,
      '  -H "Authorization: Bearer $TULIPFARM_WEBHOOK_KEY" \\',
      "  -H 'Content-Type: application/json' \\",
      `  -d '{"requestId":"'"$(uuidgen)"'","input":{"example":true}}'`,
    ].join('\n'),
  );
  const key = 'a'.repeat(64);
  const script = example.replace(/^curl /, 'printf "%s\\n" ');
  const bin = await mkdtemp(join(tmpdir(), 'webhook-curl-'));
  const requestId = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  await writeFile(join(bin, 'uuidgen'), `#!/bin/sh\necho ${requestId}\n`, { mode: 0o755 });
  const output = await new Promise((resolve, reject) =>
    execFile(
      'bash',
      ['-c', script],
      { env: { PATH: `${bin}:${process.env.PATH}`, TULIPFARM_WEBHOOK_KEY: key } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  ).finally(() => rm(bin, { recursive: true, force: true }));
  const [method, verb, target, , authorization, , contentType, , body] = output.trimEnd().split('\n');
  assert.deepEqual([method, verb, target], ['-X', 'POST', url]);
  assert.equal(authorization, `Authorization: Bearer ${key}`);
  assert.equal(contentType, 'Content-Type: application/json');
  assert.deepEqual(JSON.parse(body), { requestId, input: { example: true } });
});

async function runCurl(example: string, env: Record<string, string> = {}) {
  const bin = await mkdtemp(join(tmpdir(), 'webhook-curl-'));
  await writeFile(join(bin, 'uuidgen'), '#!/bin/sh\necho 3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f\n', { mode: 0o755 });
  await writeFile(join(bin, 'date'), '#!/bin/sh\necho 1759900000\n', { mode: 0o755 });
  const script = example.replace(/^curl /m, 'printf "%s\\n" ');
  const output = await new Promise<string>((resolve, reject) =>
    execFile(
      'bash',
      ['-c', script],
      { env: { PATH: `${bin}:${process.env.PATH}`, TULIPFARM_WEBHOOK_KEY: 'k', ...env } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  ).finally(() => rm(bin, { recursive: true, force: true }));
  return output.trimEnd().split('\n');
}

test('raw webhook triggers explain and demonstrate the active dedupe source', async () => {
  const url = 'https://api.example.com/v1/workspaces/w/workflows/f/webhook',
    requestId = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const githubShaped = {
    kind: 'webhook',
    payload: { mode: 'raw', dedupe: { source: 'header', name: 'x-github-delivery' }, headers: ['x-github-event'] },
  };
  assert.deepEqual(
    webhookPayload(workflow({ kind: 'manual' }, githubShaped)),
    githubShaped.payload,
    'The endpoint follows the active revision',
  );
  assert.equal(webhookPayload(workflow({ kind: 'webhook' }, { kind: 'webhook' })), undefined);
  assert.match(
    webhookInstructions(githubShaped.payload, 'bearer'),
    /request body is limited to 64 KiB.*run input to 32 KiB/,
  );
  assert.match(webhookInstructions(githubShaped.payload, 'bearer'), /x-github-event.*x-github-delivery/);
  assert.deepEqual(await runCurl(webhookCurl(url, githubShaped.payload, 'bearer')), [
    '-X',
    'POST',
    url,
    '-H',
    'Authorization: Bearer k',
    '-H',
    `x-github-delivery: ${requestId}`,
    '-H',
    'Content-Type: application/json',
    '-d',
    '{"example":true}',
  ]);

  const path = ['data', "$x !! it's `id`"];
  const stripeShaped = { mode: 'raw' as const, dedupe: { source: 'body' as const, path } };
  assert.match(webhookInstructions(stripeShaped, 'bearer'), /data.*id.*request body is limited to 64 KiB/);
  const example = webhookCurl(url, stripeShaped, 'bearer');
  assert.equal(
    example.split('\n').at(-1),
    `  -d '{"data":{"$x !! it'\\''s \`id\`":"'"$(uuidgen)"'"}}'`,
    'Path names sit inside single quotes, so no shell expands them',
  );
  const lines = await runCurl(example, { x: 'expanded' });
  assert.deepEqual(lines.slice(-2), ['-d', JSON.stringify({ data: { [path[1]]: requestId } })]);

  assert.equal(
    webhookInstructions({ mode: 'raw', dedupe: { source: 'hash' } }, 'bearer').includes(
      'Sending an identical body again counts as a retry of the same event.',
    ),
    true,
  );
  assert.deepEqual((await runCurl(webhookCurl(url, { mode: 'raw', dedupe: { source: 'hash' } }, 'bearer'))).slice(-2), [
    '-d',
    '{"example":true}',
  ]);
});

test('signed webhook examples compute the signature the server verifies', async () => {
  const url = 'https://api.example.com/v1/workspaces/w/workflows/f/webhook',
    requestId = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    key = 'c4'.repeat(32);
  assert.match(
    webhookInstructions(undefined, 'signed'),
    /X-TulipFarm-Timestamp.*5 minutes.*request body is limited to 64 KiB.*32 KiB/,
  );
  const example = webhookCurl(url, undefined, 'signed');
  assert.equal(example.includes(key), false, 'The example never contains the key');
  const [method, verb, target, , timestamp, , signature, , contentType, , body] = await runCurl(example, {
    TULIPFARM_WEBHOOK_KEY: key,
  });
  assert.deepEqual(
    [method, verb, target, timestamp, contentType],
    ['-X', 'POST', url, 'X-TulipFarm-Timestamp: 1759900000', 'Content-Type: application/json'],
  );
  assert.deepEqual(JSON.parse(body), { requestId, input: { example: true } });
  assert.equal(signature, `X-TulipFarm-Signature: sha256=${webhookSignature(key, 1759900000, Buffer.from(body))}`);

  const github = await runCurl(
    webhookCurl(url, { mode: 'raw', dedupe: { source: 'header', name: 'x-github-delivery' } }, 'signed'),
    { TULIPFARM_WEBHOOK_KEY: key },
  );
  assert.deepEqual(github.slice(7, 9), ['-H', `x-github-delivery: ${requestId}`]);
  assert.equal(
    github[6],
    `X-TulipFarm-Signature: sha256=${webhookSignature(key, 1759900000, Buffer.from('{"example":true}'))}`,
  );
});

test('GitHub and Stripe setup examples generate their native signatures', async () => {
  const url = 'https://api.example.com/v1/workspaces/w/workflows/f/webhook';
  const github = await runCurl(webhookCurl(url, { mode: 'raw', dedupe: { source: 'hash' } }, 'github'), {
    TULIPFARM_WEBHOOK_KEY: 'k',
  });
  const githubHeader = github.find(line => line.startsWith('X-Hub-Signature-256:'));
  assert.equal(
    githubHeader,
    `X-Hub-Signature-256: sha256=${githubWebhookSignature('k', Buffer.from(github.at(-1) ?? ''))}`,
  );

  const stripe = await runCurl(webhookCurl(url, { mode: 'raw', dedupe: { source: 'body', path: ['id'] } }, 'stripe'), {
    TULIPFARM_WEBHOOK_KEY: 'k',
  });
  const stripeHeader = stripe.find(line => line.startsWith('Stripe-Signature:'));
  const [, timestamp, signature] = stripeHeader?.match(/^Stripe-Signature: t=(\d+),v1=([a-f0-9]{64})$/) ?? [];
  assert.equal(signature, webhookSignature('k', Number(timestamp), Buffer.from(stripe.at(-1) ?? '')));
});

test('delivery log entries explain each outcome in product language', () => {
  assert.deepEqual(deliveryOutcome({ outcome: 'accepted', status: 200 }), { label: 'Run started', tone: 'success' });
  assert.deepEqual(deliveryOutcome({ outcome: 'key-rejected', status: 404 }), {
    label: 'Key or signature not accepted',
    tone: 'destructive',
  });
  assert.deepEqual(deliveryOutcome({ outcome: 'request-too-large', status: 413 }), {
    label: 'Request body over 64 KiB',
    tone: 'destructive',
  });
  assert.deepEqual(deliveryOutcome({ outcome: 'run-input-too-large', status: 413 }), {
    label: 'Workflow input over 32 KiB',
    tone: 'destructive',
  });
  assert.deepEqual(deliveryOutcome({ outcome: 'rate-limit-exceeded', status: 429 }), {
    label: 'Rate limited',
    tone: 'warning',
  });
  assert.deepEqual(deliveryOutcome({ outcome: 'webhook-key-unavailable', status: 503 }), {
    label: 'Server error (503)',
    tone: 'destructive',
  });
  assert.deepEqual(deliveryOutcome({ outcome: 'http-418', status: 418 }), {
    label: 'Rejected (418)',
    tone: 'destructive',
  });
  assert.deepEqual(
    [deliveryRun({ runStarted: true }), deliveryRun({ runStarted: false })],
    ['Run not shared with you', 'No run'],
  );
  assert.deepEqual([byteSize(null), byteSize(312), byteSize(70017)], [null, '312 B', '68.4 KiB']);
});
