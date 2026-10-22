import { randomUUID } from 'node:crypto';
import { decrypt, encryptVersioned, parseKeyring, versionedEnvelopeSchema, type Keyring } from '@tulipfarm/keyring';
import type { Pool } from 'pg';
import { z } from 'zod';

const payloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('invitation'),
    email: z.email(),
    url: z.url(),
    workspaceName: z.string().optional(),
    expiresAt: z.iso.datetime().optional(),
  }),
  z.object({ kind: z.literal('magic-link'), email: z.email(), url: z.url() }),
  z.object({ kind: z.literal('password-reset'), email: z.email(), url: z.url() }),
]);
export type EmailDeliveryPayload = z.infer<typeof payloadSchema>;
export type EmailDeliveryKeys = Keyring;

export function emailDeliveryKeys(): EmailDeliveryKeys {
  try {
    return parseKeyring(process.env, 'EMAIL_DELIVERY');
  } catch {
    throw new Error('Email encryption configuration unavailable');
  }
}

const binding = (id: string) => (keyId: string) =>
  Buffer.from(JSON.stringify(['email-delivery', 1, z.uuid().parse(id), keyId]));

export function encryptEmailDelivery(id: string, payload: EmailDeliveryPayload, keys: EmailDeliveryKeys) {
  return encryptVersioned(JSON.stringify(payloadSchema.parse(payload)), keys, binding(id));
}

export function decryptEmailDelivery(id: string, input: unknown, keys: EmailDeliveryKeys): EmailDeliveryPayload {
  try {
    return payloadSchema.parse(JSON.parse(decrypt(versionedEnvelopeSchema.parse(input), keys, binding(id))));
  } catch {
    throw new Error('Email payload unavailable');
  }
}

export function createEmailDeliveryStore(pool: Pick<Pool, 'query'>, keys: EmailDeliveryKeys) {
  // The delivery expires with the link: 15 minutes for a magic link, an hour for a password reset.
  async function enqueueLink(kind: 'magic-link' | 'password-reset', email: string, url: string) {
    try {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO app.email_deliveries (id, kind, payload, expires_at) VALUES ($1, $2, $3, clock_timestamp() + $4 * interval '1 minute')`,
        [id, kind, encryptEmailDelivery(id, { kind, email, url }, keys), kind === 'magic-link' ? 15 : 60],
      );
      return id;
    } catch {
      throw new Error('Email queue unavailable');
    }
  }
  const enqueueMagicLink = (email: string, url: string) => enqueueLink('magic-link', email, url);
  const enqueuePasswordReset = (email: string, url: string) => enqueueLink('password-reset', email, url);

  async function pending() {
    await pool.query(
      `UPDATE app.email_deliveries SET status = 'cancelled', payload = NULL, lease_until = NULL WHERE expires_at <= clock_timestamp() AND payload IS NOT NULL`,
    );
    return z
      .array(z.object({ id: z.uuid() }))
      .parse(
        (
          await pool.query(
            `SELECT id FROM app.email_deliveries WHERE payload IS NOT NULL AND (lease_until IS NULL OR lease_until <= clock_timestamp()) ORDER BY created_at, id LIMIT 100`,
          )
        ).rows,
      )
      .map(row => row.id);
  }

  async function deliver(idInput: string, send: (payload: EmailDeliveryPayload) => Promise<void>) {
    const id = z.uuid().parse(idInput);
    try {
      const row = z
        .object({ payload: z.unknown(), attempts: z.number().int() })
        .optional()
        .parse(
          (
            await pool.query(
              `UPDATE app.email_deliveries SET status = 'sending', attempts = attempts + 1, lease_until = clock_timestamp() + interval '2 minutes' WHERE id = $1 AND payload IS NOT NULL AND expires_at > clock_timestamp() AND (lease_until IS NULL OR lease_until <= clock_timestamp()) RETURNING payload, attempts`,
              [id],
            )
          ).rows[0],
        );
      if (!row) return;
      try {
        await send(decryptEmailDelivery(id, row.payload, keys));
        await pool.query(
          `UPDATE app.email_deliveries SET status = 'sent', payload = NULL, lease_until = NULL, sent_at = clock_timestamp() WHERE id = $1 AND status = 'sending' AND attempts = $2`,
          [id, row.attempts],
        );
      } catch {
        await pool.query(
          `UPDATE app.email_deliveries SET status = 'failed', lease_until = clock_timestamp() + least(3600, 30 * power(2, least(attempts - 1, 7))) * interval '1 second' WHERE id = $1 AND status = 'sending' AND attempts = $2`,
          [id, row.attempts],
        );
        throw new Error('Email delivery failed');
      }
    } catch {
      throw new Error('Email delivery failed');
    }
  }
  return { enqueueMagicLink, enqueuePasswordReset, pending, deliver };
}
