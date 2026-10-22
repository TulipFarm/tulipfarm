import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { integrationCredentialKeyring, type IntegrationKeyring } from '@tulipfarm/integrations/credentials';
import { GoogleWorkspaceError } from './contracts.ts';

const envelopeSchema = z.strictObject({
  keyId: z.string(),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string().max(131072),
});
export const tokenBundleSchema = z.strictObject({
  accessToken: z.string().min(1).max(16384),
  refreshToken: z.string().min(1).max(16384),
  expiresAt: z.number().finite(),
  refreshExpiresAt: z.number().finite().nullable(),
});
export type TokenBundle = z.infer<typeof tokenBundleSchema>;
export type CredentialBinding = {
  workspaceId: string;
  integrationId: string;
  userId: string;
  membershipId: string;
  accountId: string | null;
  generation: number;
};

export function googleCredentialCipher(input?: IntegrationKeyring) {
  function key(id?: string) {
    const ring = input ?? integrationCredentialKeyring();
    const keyId = id ?? ring.activeKeyId;
    return {
      keyId,
      value: Buffer.from(
        z
          .string()
          .regex(/^[a-fA-F0-9]{64}$/)
          .parse(ring.keys[keyId]),
        'hex',
      ),
    };
  }
  function aad(purpose: 'tokens' | 'pkce', binding: CredentialBinding) {
    return Buffer.from(
      JSON.stringify([
        'google-workspace',
        purpose,
        binding.workspaceId,
        binding.integrationId,
        binding.userId,
        binding.membershipId,
        binding.accountId,
        binding.generation,
      ]),
    );
  }
  return {
    encrypt(purpose: 'tokens' | 'pkce', binding: CredentialBinding, plaintext: string) {
      try {
        const active = key();
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', active.value, nonce);
        cipher.setAAD(aad(purpose, binding));
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return {
          keyId: active.keyId,
          nonce: nonce.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        };
      } catch {
        throw new GoogleWorkspaceError('credential-unavailable');
      }
    },
    decrypt(purpose: 'tokens' | 'pkce', binding: CredentialBinding, envelope: unknown) {
      try {
        const value = envelopeSchema.parse(envelope);
        const nonce = Buffer.from(value.nonce, 'base64');
        const tag = Buffer.from(value.tag, 'base64');
        if (nonce.length !== 12 || tag.length !== 16) throw new Error();
        const cipher = createDecipheriv('aes-256-gcm', key(value.keyId).value, nonce);
        cipher.setAAD(aad(purpose, binding));
        cipher.setAuthTag(tag);
        return Buffer.concat([cipher.update(Buffer.from(value.ciphertext, 'base64')), cipher.final()]).toString('utf8');
      } catch {
        throw new GoogleWorkspaceError('credential-unavailable');
      }
    },
  };
}
