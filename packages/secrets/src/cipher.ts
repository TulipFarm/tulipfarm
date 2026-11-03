import { createHash } from 'node:crypto';
import { z } from 'zod';
import { compactEnvelopeSchema, decrypt, encryptCompact, type Keyring } from '@tulipfarm/keyring';
import { SecretError, type Placement, type SecretKind, parseValue, type SecretValue } from './contracts.ts';

/** The `INTEGRATION_CREDENTIAL` keyring in the shape the apps already load: hex keys by ID. */
export const secretKeyringSchema = z.strictObject({
  activeKeyId: z.string().min(1),
  keys: z.record(z.string(), z.string().regex(/^[a-fA-F0-9]{64}$/)),
});
export type SecretKeyring = z.infer<typeof secretKeyringSchema>;

type Binding = { workspaceId: string; secretId: string; version: number; placement: Placement };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export const placementDigest = (placement: Placement) =>
  createHash('sha256').update(canonical(placement)).digest('base64url');

// Binding the placement means a stored value cannot be moved to another placement.
const associatedData = (binding: Binding) =>
  Buffer.from(
    JSON.stringify([
      'workspace-secret-v1',
      binding.workspaceId,
      binding.secretId,
      binding.version,
      placementDigest(binding.placement),
    ]),
  );

export function secretCipher(input: SecretKeyring | (() => SecretKeyring)) {
  let ring: Keyring | undefined;
  function keys(): Keyring {
    if (ring) return ring;
    try {
      const parsed = secretKeyringSchema.parse(typeof input === 'function' ? input() : input);
      const key = parsed.keys[parsed.activeKeyId];
      if (!key) throw new Error();
      ring = {
        keyId: parsed.activeKeyId,
        key: Buffer.from(key, 'hex'),
        previous: new Map(
          Object.entries(parsed.keys)
            .filter(([id]) => id !== parsed.activeKeyId)
            .map(([id, hex]) => [id, Buffer.from(hex, 'hex')]),
        ),
      };
      return ring;
    } catch {
      throw new SecretError('credential-unavailable');
    }
  }
  return {
    /** Throws `credential-unavailable` when the keyring cannot load. */
    check() {
      keys();
    },
    encrypt(binding: Binding, value: SecretValue) {
      return encryptCompact(JSON.stringify(value), keys(), associatedData(binding));
    },
    decrypt(binding: Binding, kind: SecretKind, envelope: unknown): SecretValue {
      const ring = keys();
      try {
        return parseValue(
          kind,
          JSON.parse(decrypt(compactEnvelopeSchema.parse(envelope), ring, associatedData(binding))),
        );
      } catch {
        throw new SecretError('credential-unavailable');
      }
    },
  };
}
export type SecretCipher = ReturnType<typeof secretCipher>;
