import type { z } from 'zod';
import type {
  rawWebhookSchema,
  webhookDeliverySchema,
  webhookModeSchema,
  workflowSchema,
} from '@tulipfarm/workflows/contracts';

type Workflow = z.infer<typeof workflowSchema>;
export type WebhookMode = z.infer<typeof webhookModeSchema>;
type TriggerKind = Workflow['definition']['trigger']['kind'];

const triggerName: Record<TriggerKind, string> = {
  manual: 'manual',
  webhook: 'webhook',
  event: 'event',
  once: 'one-time',
  interval: 'repeating',
  cron: 'schedule',
  provider: 'connected service',
  record: 'record date',
  row: 'row change',
};

export function webhookStatus(workflow: Workflow) {
  const saved = workflow.definition.trigger.kind;
  const active = workflow.activeTrigger?.kind ?? null;
  const receiving = workflow.enabled && active === 'webhook' && workflow.webhookConfigured;
  const endpoint = receiving
    ? 'Receiving requests. Calls that use the current key start the active revision.'
    : workflow.enabled && active === 'webhook'
      ? 'Not receiving requests. Create a key to start accepting calls.'
      : active === null
        ? 'Not receiving requests. Activate the saved revision to accept calls.'
        : !workflow.enabled
          ? 'Not receiving requests. The workflow is disabled. Activate the saved revision to accept calls.'
          : `Not receiving requests. The active revision uses a ${triggerName[active]} trigger. Activate the saved revision to accept calls.`;
  return {
    visible: saved === 'webhook' || active === 'webhook',
    configured: workflow.webhookConfigured,
    receiving,
    endpoint,
    change:
      active === 'webhook' && saved !== 'webhook'
        ? `The saved revision uses a ${triggerName[saved]} trigger. Activating it stops this endpoint and deletes the webhook key.`
        : null,
  };
}

type RawWebhook = z.infer<typeof rawWebhookSchema>;

export function webhookPayload(workflow: Workflow): RawWebhook | undefined {
  const trigger = workflow.activeTrigger?.kind === 'webhook' ? workflow.activeTrigger : workflow.definition.trigger;
  return trigger.kind === 'webhook' ? trigger.payload : undefined;
}

const credential: Record<WebhookMode, string> = {
  bearer: 'Send your key in the Authorization header.',
  signed:
    'Sign each request instead of sending the key. Send X-TulipFarm-Timestamp with the current Unix time in seconds and X-TulipFarm-Signature with sha256= followed by the hex HMAC-SHA256 of the timestamp, a period, and the exact body bytes, using your key. Requests more than 5 minutes from server time, or that reuse a signature, are rejected.',
  github:
    'Use the generated key as the webhook secret in GitHub. The server verifies X-Hub-Signature-256 as the HMAC-SHA256 of the exact body bytes.',
  stripe:
    'Use the endpoint signing secret from Stripe. The server verifies Stripe-Signature over the timestamp and exact body bytes, and rejects stale or replayed signatures.',
};

export function webhookInstructions(payload: RawWebhook | undefined, mode: WebhookMode) {
  const limit =
    'The request body is limited to 64 KiB and the workflow run input to 32 KiB; rejections appear in the delivery log.';
  if (!payload)
    return `${credential[mode]} Send a JSON body with a unique requestId UUID and an input value. Repeat the same requestId only to retry the same event. ${limit}`;
  const copied = payload.headers?.length
    ? ` The run input holds that body and the sent values of these headers: ${payload.headers.join(', ')}.`
    : '';
  const retry =
    payload.dedupe.source === 'header'
      ? `Repeat the same ${payload.dedupe.name} header value only to retry the same event.`
      : payload.dedupe.source === 'body'
        ? `Repeat the same body value at ${payload.dedupe.path.join('.')} only to retry the same event.`
        : 'Sending an identical body again counts as a retry of the same event.';
  return `${credential[mode]} Send a JSON or form-encoded body up to 64 KiB; the workflow run input cannot exceed 32 KiB.${copied} ${retry} ${limit}`;
}

// Single quotes keep pasted path names literal, including `!` in interactive shells.
const shellQuoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const generatedId = `'"$(uuidgen)"'`;

export function webhookCurl(url: string, payload: RawWebhook | undefined, mode: WebhookMode) {
  const marker = 'TULIPFARM_GENERATED_ID';
  let body: unknown = payload ? { example: true } : { requestId: marker, input: { example: true } };
  if (payload?.dedupe.source === 'body')
    body = payload.dedupe.path.reduceRight<unknown>((value, part) => ({ [part]: value }), marker);
  const quotedBody = shellQuoted(JSON.stringify(body)),
    at = quotedBody.lastIndexOf(marker);
  const dedupeHeader =
    payload?.dedupe.source === 'header' ? [`  -H ${shellQuoted(`${payload.dedupe.name}: `)}"$(uuidgen)" \\`] : [];
  const data = at < 0 ? quotedBody : `${quotedBody.slice(0, at)}${generatedId}${quotedBody.slice(at + marker.length)}`;
  if (mode === 'github' || mode === 'stripe' || mode === 'signed') {
    const timestamp = mode === 'github' ? [] : ['timestamp=$(date +%s)'];
    const signingInput =
      mode === 'stripe'
        ? `printf '%s.%s' "$timestamp" "$body"`
        : mode === 'github'
          ? `printf '%s' "$body"`
          : `printf '%s.%s' "$timestamp" "$body"`;
    const signature = `signature=$(${signingInput} | openssl dgst -sha256 -hmac "$TULIPFARM_WEBHOOK_KEY" | sed 's/^.*= //')`;
    const authHeaders =
      mode === 'github'
        ? ['  -H "X-Hub-Signature-256: sha256=$signature" \\']
        : mode === 'stripe'
          ? ['  -H "Stripe-Signature: t=$timestamp,v1=$signature" \\']
          : ['  -H "X-TulipFarm-Timestamp: $timestamp" \\', '  -H "X-TulipFarm-Signature: sha256=$signature" \\'];
    return [
      `body=${data}`,
      ...timestamp,
      signature,
      `curl -X POST ${shellQuoted(url)} \\`,
      ...authHeaders,
      ...dedupeHeader,
      `  -H 'Content-Type: application/json' \\`,
      '  --data-binary "$body"',
    ].join('\n');
  }
  return [
    `curl -X POST ${shellQuoted(url)} \\`,
    ['  -H "Authorization: ', 'Bear', 'er', ' $TULIPFARM_WEBHOOK_KEY" \\'].join(''),
    ...dedupeHeader,
    `  -H 'Content-Type: application/json' \\`,
    `  -d ${data}`,
  ].join('\n');
}

type Delivery = z.infer<typeof webhookDeliverySchema>;
type Tone = 'success' | 'info' | 'warning' | 'destructive';
const outcomes: Record<string, { label: string; tone: Tone }> = {
  accepted: { label: 'Run started', tone: 'success' },
  duplicate: { label: 'Retry of an earlier request', tone: 'info' },
  'key-missing': { label: 'No key or signature sent', tone: 'destructive' },
  'key-rejected': { label: 'Key or signature not accepted', tone: 'destructive' },
  'workflow-inactive': { label: 'Workflow not active', tone: 'warning' },
  'workflow-disabled': { label: 'Workflow not active', tone: 'warning' },
  'invalid-request': { label: 'Body not accepted', tone: 'destructive' },
  'request-too-large': { label: 'Request body over 64 KiB', tone: 'destructive' },
  'run-input-too-large': { label: 'Workflow input over 32 KiB', tone: 'destructive' },
  'unsupported-media-type': { label: 'Unsupported body format', tone: 'destructive' },
  'request-conflict': { label: 'Request ID reused with a different body', tone: 'destructive' },
  'webhook-signature-expired': { label: 'Timestamp more than 5 minutes off', tone: 'destructive' },
  'webhook-signature-replayed': { label: 'Signature already used', tone: 'destructive' },
  'rate-limit-exceeded': { label: 'Rate limited', tone: 'warning' },
  'limit-reached': { label: 'Run limit reached', tone: 'warning' },
};

/** How a logged delivery reads to a person; unknown codes fall back to the HTTP status. */
export function deliveryOutcome(delivery: Pick<Delivery, 'outcome' | 'status'>) {
  return (
    outcomes[delivery.outcome] ?? {
      label: delivery.status >= 500 ? `Server error (${delivery.status})` : `Rejected (${delivery.status})`,
      tone: 'destructive' as const,
    }
  );
}

/** Describes the run cell when there is no run the reader can open. */
export function deliveryRun(delivery: Pick<Delivery, 'runStarted'>) {
  return delivery.runStarted ? 'Run not shared with you' : 'No run';
}

export function byteSize(bytes: number | null) {
  return bytes === null ? null : bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}
