import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { IntegrationKeyring } from '@tulipfarm/integrations';
import { McpError } from './contracts.ts';

const envelopeSchema = z.strictObject({
  keyId: z.string(),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});
type Binding = { workspaceId: string; integrationId: string; version: number; purpose: 'credential' | 'oauth' };
export function mcpCredentialCipher(keyring: IntegrationKeyring) {
  const context = (binding: Binding) =>
    Buffer.from(
      JSON.stringify([
        'workspace-mcp-v1',
        z.uuid().parse(binding.workspaceId),
        z.uuid().parse(binding.integrationId),
        z.number().int().positive().parse(binding.version),
        binding.purpose,
      ]),
    );
  const key = (id: string) =>
    Buffer.from(
      z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/)
        .parse(keyring.keys[id]),
      'hex',
    );
  return {
    encrypt(binding: Binding, plaintext: string) {
      try {
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key(keyring.activeKeyId), nonce);
        cipher.setAAD(context(binding));
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return {
          keyId: keyring.activeKeyId,
          nonce: nonce.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        };
      } catch {
        throw new McpError('credential-unavailable');
      }
    },
    decrypt(binding: Binding, input: unknown) {
      try {
        const envelope = envelopeSchema.parse(input);
        const nonce = Buffer.from(envelope.nonce, 'base64');
        const tag = Buffer.from(envelope.tag, 'base64');
        if (nonce.length !== 12 || tag.length !== 16) throw new Error();
        const cipher = createDecipheriv('aes-256-gcm', key(envelope.keyId), nonce);
        cipher.setAAD(context(binding));
        cipher.setAuthTag(tag);
        return Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]).toString(
          'utf8',
        );
      } catch {
        throw new McpError('credential-unavailable');
      }
    },
  };
}
