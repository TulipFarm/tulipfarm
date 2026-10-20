import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import type { credentialCipher } from '@tulipfarm/integrations/credentials';
import { githubWebhookSignature } from '@tulipfarm/github/event-signature';
import {
  webhookModeSchema,
  webhookSignatureHeader,
  webhookSigningSecretSchema,
  webhookTimestampHeader,
} from './contracts.ts';
export { githubWebhookSignature };

type Cipher = ReturnType<typeof credentialCipher>;
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
// A bearer key is stored only as its hash. A signing key must be recoverable to compute HMACs, so it is sealed with the integration keyring.
export const storedWebhookKeySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('bearer'), digest: hex64 }),
  z.strictObject({ mode: z.literal('signed'), generation: z.number().int().positive(), envelope: z.unknown() }),
  z.strictObject({ mode: z.literal('github'), generation: z.number().int().positive(), envelope: z.unknown() }),
  z.strictObject({ mode: z.literal('stripe'), generation: z.number().int().positive(), envelope: z.unknown() }),
]);
export type StoredWebhookKey = z.infer<typeof storedWebhookKeySchema>;
export type WebhookMode = z.infer<typeof webhookModeSchema>;
type Headers = Record<string, string | string[] | undefined>;
export type WebhookDelivery = { body: unknown; raw?: Buffer; headers: Headers };
export type WebhookProof =
  | { kind: 'bearer'; key: string }
  | { kind: 'signed' | 'stripe'; timestamp: number; signature: string; raw: Buffer }
  | { kind: 'github'; signature: string; raw: Buffer };

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (left: string, right: string) =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const single = (headers: Headers, name: string) => {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
};

export function issueWebhookKey(
  cipher: Cipher,
  workspaceId: string,
  workflowId: string,
  generation: number,
  mode: WebhookMode,
  secret?: string,
): { key: string | null; stored: StoredWebhookKey } {
  const key = secret ?? randomBytes(32).toString('hex');
  return {
    key: secret ? null : key,
    stored:
      mode === 'bearer'
        ? { mode, digest: digest(key) }
        : { mode, generation, envelope: cipher.encrypt(workspaceId, workflowId, generation, key, 'workflow-webhook') },
  };
}

/** Reads the credential a delivery presents; a request without one is rejected before any storage read. */
export function webhookProof(delivery: WebhookDelivery): WebhookProof[] {
  const proofs: WebhookProof[] = [];
  const bearer = single(delivery.headers, 'authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (bearer) proofs.push({ kind: 'bearer', key: bearer });
  const timestamp = single(delivery.headers, webhookTimestampHeader)?.match(/^\d{1,12}$/)?.[0];
  const signature = single(delivery.headers, webhookSignatureHeader)?.match(/^sha256=([a-fA-F0-9]{64})$/)?.[1];
  if (timestamp && signature && delivery.raw)
    proofs.push({
      kind: 'signed',
      timestamp: Number(timestamp),
      signature: signature.toLowerCase(),
      raw: delivery.raw,
    });
  if (delivery.raw) {
    const github = single(delivery.headers, 'x-hub-signature-256')?.match(/^sha256=([a-fA-F0-9]{64})$/)?.[1];
    if (github) proofs.push({ kind: 'github', signature: github.toLowerCase(), raw: delivery.raw });
    const stripe =
      single(delivery.headers, 'stripe-signature')
        ?.split(',')
        .map(value => value.trim()) ?? [];
    const timestamps = stripe.filter(value => /^t=\d{1,12}$/.test(value)).map(value => value.slice(2));
    if (timestamps.length === 1) {
      for (const value of stripe) {
        const stripeSignature = value.match(/^v1=([a-fA-F0-9]{64})$/)?.[1];
        if (stripeSignature)
          proofs.push({
            kind: 'stripe',
            timestamp: Number(timestamps[0]),
            signature: stripeSignature.toLowerCase(),
            raw: delivery.raw,
          });
      }
    }
  }
  return proofs;
}

export function webhookSignature(key: string, timestamp: number, raw: Buffer) {
  return createHmac('sha256', key).update(`${timestamp}.`).update(raw).digest('hex');
}

export class WebhookKeyUnavailable extends Error {}
/** Answered to the sender like any missing workflow; the reason reaches only the delivery log. */
export class WebhookRejected extends AccessDenied {
  readonly reason: 'key-missing' | 'key-rejected' | 'workflow-inactive';
  constructor(reason: WebhookRejected['reason']) {
    super();
    this.reason = reason;
  }
}

/** Returns the proof that matched one of the accepted keys, or null. A key that cannot be unsealed never hides another key that matches. */
export function matchWebhookKey(
  cipher: Cipher,
  workspaceId: string,
  workflowId: string,
  keys: StoredWebhookKey[],
  proofs: WebhookProof[],
) {
  let unsealed = true;
  for (const stored of keys) {
    for (const proof of proofs) {
      if (stored.mode === 'bearer' && proof.kind === 'bearer' && same(digest(proof.key), stored.digest)) return proof;
      if (stored.mode === 'github' && proof.kind === 'github') {
        let key;
        try {
          key = webhookSigningSecretSchema.parse(
            cipher.decrypt(workspaceId, workflowId, stored.generation, stored.envelope, 'workflow-webhook'),
          );
        } catch {
          unsealed = false;
          continue;
        }
        if (same(githubWebhookSignature(key, proof.raw), proof.signature)) return proof;
      }
      if (
        (stored.mode === 'signed' && proof.kind === 'signed') ||
        (stored.mode === 'stripe' && proof.kind === 'stripe')
      ) {
        let key;
        try {
          key = webhookSigningSecretSchema.parse(
            cipher.decrypt(workspaceId, workflowId, stored.generation, stored.envelope, 'workflow-webhook'),
          );
        } catch {
          unsealed = false;
          continue;
        }
        if (same(webhookSignature(key, proof.timestamp, proof.raw), proof.signature)) return proof;
      }
    }
  }
  if (!unsealed) throw new WebhookKeyUnavailable('webhook-key-unavailable');
  return null;
}
