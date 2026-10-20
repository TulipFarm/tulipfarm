import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { IntegrationKeyring } from '@tulipfarm/integrations';
import { AccountError, accountProtocolSchema, accountUuidSchema } from './account-contracts.ts';

const bindingSchema = z.strictObject({
  workspaceId: accountUuidSchema,
  accountId: accountUuidSchema,
  protocol: accountProtocolSchema,
  generation: z.number().int().positive(),
  purpose: z.enum(['tokens', 'pkce']),
});
type Binding = z.infer<typeof bindingSchema>;
const envelopeSchema = z.strictObject({
  keyId: z.string(),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string().max(65536),
});
const key = z.string().regex(/^[a-f0-9]{64}$/i);
export function accountCredentialCipher(ring: IntegrationKeyring) {
  const aad = (binding: Binding) => Buffer.from(JSON.stringify(['atlassian-account', bindingSchema.parse(binding)]));
  return {
    encrypt(binding: Binding, value: string) {
      try {
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', Buffer.from(key.parse(ring.keys[ring.activeKeyId]), 'hex'), nonce);
        cipher.setAAD(aad(binding));
        const ciphertext = Buffer.concat([cipher.update(z.string().max(40000).parse(value), 'utf8'), cipher.final()]);
        return {
          keyId: ring.activeKeyId,
          nonce: nonce.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        };
      } catch {
        throw new AccountError('account-unavailable');
      }
    },
    decrypt(binding: Binding, input: unknown) {
      try {
        const value = envelopeSchema.parse(input);
        const nonce = Buffer.from(value.nonce, 'base64');
        const tag = Buffer.from(value.tag, 'base64');
        if (nonce.length !== 12 || tag.length !== 16) throw new Error();
        const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key.parse(ring.keys[value.keyId]), 'hex'), nonce);
        cipher.setAAD(aad(binding));
        cipher.setAuthTag(tag);
        return Buffer.concat([cipher.update(Buffer.from(value.ciphertext, 'base64')), cipher.final()]).toString('utf8');
      } catch {
        throw new AccountError('account-unavailable');
      }
    },
  };
}
