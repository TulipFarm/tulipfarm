import { compactEnvelopeSchema, decrypt, encryptCompact, parseKeyring } from '@tulipfarm/keyring';
import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { IntegrationError, tokenSchema } from './contracts.ts';

const keyIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const keyId = z.string().regex(keyIdPattern);
const keySchema = z.string().regex(/^[a-fA-F0-9]{64}$/);
const keyringSchema = z.strictObject({ activeKeyId: keyId, keys: z.record(keyId, keySchema) });
export type IntegrationKeyring = z.infer<typeof keyringSchema>;
const envelopeSchema = compactEnvelopeSchema.extend({ keyId });
export type Envelope = z.infer<typeof envelopeSchema>;
type CredentialPurpose = 'connection' | 'workflow-webhook';

export function integrationCredentialKeyring(env: NodeJS.ProcessEnv = process.env): IntegrationKeyring {
  try {
    const ring = parseKeyring(env, 'INTEGRATION_CREDENTIAL', { keyId: keyIdPattern });
    return {
      activeKeyId: ring.keyId,
      keys: {
        ...Object.fromEntries([...ring.previous].map(([id, key]) => [id, key.toString('hex')])),
        [ring.keyId]: ring.key.toString('hex'),
      },
    };
  } catch {
    throw new IntegrationError('credential-unavailable');
  }
}

export function credentialCipher(input?: IntegrationKeyring) {
  let keyring: IntegrationKeyring | undefined;
  function keys() {
    try {
      return (keyring ??= keyringSchema.parse(input ?? integrationCredentialKeyring()));
    } catch {
      throw new IntegrationError('credential-unavailable');
    }
  }
  // The purpose keeps an envelope sealed for one kind of owner from decrypting under another owner with the same ID.
  const context = (workspaceId: string, integrationId: string, generation: number, purpose: CredentialPurpose) =>
    Buffer.from(JSON.stringify([purpose, uuidSchema.parse(workspaceId), uuidSchema.parse(integrationId), generation]));
  return {
    encrypt(
      workspaceId: string,
      integrationId: string,
      generation: number,
      token: string,
      purpose: CredentialPurpose = 'connection',
    ): Envelope {
      try {
        const ring = keys();
        const key = Buffer.from(keySchema.parse(ring.keys[ring.activeKeyId]), 'hex');
        return encryptCompact(
          tokenSchema.parse(token),
          { keyId: ring.activeKeyId, key },
          context(workspaceId, integrationId, generation, purpose),
        );
      } catch {
        throw new IntegrationError('credential-unavailable');
      }
    },
    decrypt(
      workspaceId: string,
      integrationId: string,
      generation: number,
      input: unknown,
      purpose: CredentialPurpose = 'connection',
    ): string {
      try {
        const value = envelopeSchema.parse(input);
        const key = Buffer.from(keySchema.parse(keys().keys[value.keyId]), 'hex');
        return tokenSchema.parse(
          decrypt(value, { keyId: value.keyId, key }, context(workspaceId, integrationId, generation, purpose)),
        );
      } catch {
        throw new IntegrationError('credential-unavailable');
      }
    },
  };
}
