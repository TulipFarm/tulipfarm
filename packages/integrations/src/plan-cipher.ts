import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { IntegrationKeyring } from './credentials.ts';

const keyPattern = z.string().regex(/^[a-f0-9]{64}$/i);
const envelopeSchema = z.strictObject({
  keyId: z.string(),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string().max(65536),
});
type Binding = readonly (string | number)[];

/**
 * AES-256-GCM for a plan's stored tokens. `label` and the binding, such as the connection's owner and generation, are
 * the authenticated context, so a ciphertext copied to another row or provider does not decrypt.
 */
export function planTokenCipher(ring: IntegrationKeyring, label: string, failure: () => Error) {
  const aad = (binding: Binding) => Buffer.from(JSON.stringify([label, ...binding]));
  return {
    encrypt(binding: Binding, value: unknown) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv(
        'aes-256-gcm',
        Buffer.from(keyPattern.parse(ring.keys[ring.activeKeyId]), 'hex'),
        nonce,
      );
      cipher.setAAD(aad(binding));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return {
        keyId: ring.activeKeyId,
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    },
    decrypt<T>(binding: Binding, input: unknown, schema: z.ZodType<T>): T {
      try {
        const value = envelopeSchema.parse(input);
        const nonce = Buffer.from(value.nonce, 'base64');
        const tag = Buffer.from(value.tag, 'base64');
        if (nonce.length !== 12 || tag.length !== 16) throw new Error('envelope');
        const cipher = createDecipheriv(
          'aes-256-gcm',
          Buffer.from(keyPattern.parse(ring.keys[value.keyId]), 'hex'),
          nonce,
        );
        cipher.setAAD(aad(binding));
        cipher.setAuthTag(tag);
        const plain = Buffer.concat([cipher.update(Buffer.from(value.ciphertext, 'base64')), cipher.final()]);
        return schema.parse(JSON.parse(plain.toString('utf8')));
      } catch {
        throw failure();
      }
    },
  };
}
