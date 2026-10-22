import type { Trigger } from './contracts.ts';

type WebhookTrigger = Extract<Trigger, { kind: 'webhook' }>;
export type WebhookHeaders = Record<string, string | string[] | undefined>;

export const bodyAt = (body: unknown, path: string[]) =>
  path.reduce<unknown>(
    (item, part) =>
      item !== null && typeof item === 'object' && Object.hasOwn(item, part) ? Reflect.get(item, part) : undefined,
    body,
  );
export const sentHeader = (headers: WebhookHeaders, name: string) => {
  const sent = headers[name];
  return Array.isArray(sent) ? sent.join(', ') : sent;
};

/** The identifier a sender attached to a delivery, as the trigger defines it. A body hash identifies nothing a person would recognize. */
export function deliveryRequestId(trigger: Trigger | null, body: unknown, headers: WebhookHeaders) {
  const dedupe = trigger?.kind === 'webhook' ? trigger.payload?.dedupe : undefined;
  const value = !dedupe
    ? bodyAt(body, ['requestId'])
    : dedupe.source === 'header'
      ? sentHeader(headers, dedupe.name)
      : dedupe.source === 'body'
        ? bodyAt(body, dedupe.path)
        : undefined;
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  return text ? text.slice(0, 200) : null;
}

/** A sample delivery that the trigger accepts, identified by requestId wherever the trigger reads a sender's identifier. */
export function webhookSample(trigger: WebhookTrigger, requestId: string): { body: unknown; headers: WebhookHeaders } {
  const payload = trigger.payload;
  if (!payload) return { body: { requestId, input: { test: true } }, headers: {} };
  const dedupe = payload.dedupe;
  if (dedupe.source === 'header') return { body: { test: true, requestId }, headers: { [dedupe.name]: requestId } };
  if (dedupe.source === 'body')
    return {
      body: Object.assign(
        { test: true },
        dedupe.path.reduceRight<unknown>((value, part) => ({ [part]: value }), requestId),
      ),
      headers: {},
    };
  return { body: { test: true, requestId }, headers: {} };
}
