import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { IntegrationKeyring } from '@tulipfarm/integrations';
import { platformSchema } from './contracts.ts';

export class SocialError extends Error {
  constructor(
    readonly code:
      | 'platform-unavailable'
      | 'workspace-app-required'
      | 'platform-app-not-found'
      | 'account-conflict'
      | 'account-limit-reached'
      | 'account-authorization-denied'
      | 'account-reconnect-required'
      | 'account-unavailable',
  ) {
    super(code);
    this.name = 'SocialError';
  }
}

const version = z.number().int().positive();
/**
 * An envelope is bound to its workspace, subject, platform and generation. Tokens are also bound to
 * `credentialVersion`, which a refresh increases while `generation` stays the same.
 */
const bindingSchema = z.discriminatedUnion('purpose', [
  z.strictObject({
    purpose: z.enum(['tokens', 'channel-token']),
    workspaceId: z.uuid(),
    accountId: z.uuid(),
    platform: platformSchema,
    generation: version,
    credentialVersion: version,
  }),
  z.strictObject({
    purpose: z.literal('pkce'),
    workspaceId: z.uuid(),
    accountId: z.uuid(),
    platform: platformSchema,
    generation: version,
  }),
  z.strictObject({
    purpose: z.literal('app-secret'),
    workspaceId: z.uuid(),
    platformAppId: z.uuid(),
    platform: platformSchema,
    generation: version,
  }),
]);
export type CredentialBinding = z.infer<typeof bindingSchema>;
const envelopeSchema = z.strictObject({
  keyId: z.string(),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string().max(65536),
});
const key = z.string().regex(/^[a-f0-9]{64}$/i);

/** AES-256-GCM envelopes under the `INTEGRATION_CREDENTIAL` keyring, as for Atlassian accounts. */
export function socialCredentialCipher(ring: IntegrationKeyring) {
  const aad = (binding: CredentialBinding) => {
    const value = bindingSchema.parse(binding);
    // A fixed key order keeps the authenticated data stable however the binding was built.
    const ordered = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    return Buffer.from(JSON.stringify(['social-credential', ordered]));
  };
  return {
    encrypt(binding: CredentialBinding, value: string) {
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
        throw new SocialError('account-unavailable');
      }
    },
    decrypt(binding: CredentialBinding, input: unknown) {
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
        throw new SocialError('account-unavailable');
      }
    },
  };
}
export type SocialCredentialCipher = ReturnType<typeof socialCredentialCipher>;
