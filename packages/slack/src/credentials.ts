import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

const commonBinding = { workspaceId: z.uuid(), installationId: z.uuid(), generation: z.number().int().positive() };
const bindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...commonBinding, kind: z.literal('bot') }),
  z.strictObject({
    ...commonBinding,
    kind: z.literal('user'),
    identityId: z.uuid(),
    membershipId: z.uuid(),
    slackUserId: z.string().min(1),
  }),
]);
export type SlackCredentialBinding = z.infer<typeof bindingSchema>;
const ringSchema = z.strictObject({
  activeKeyId: z.string().min(1).max(64),
  keys: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/i)),
});
const envelopeSchema = z.strictObject({
  keyId: z.string(),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});
export const rotationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready'), expiresAt: z.number().int(), refresh: envelopeSchema }),
  z.object({ state: z.literal('refreshing'), attempt: z.uuid(), deadline: z.number().int() }),
  z.object({ state: z.literal('reconnect-required') }),
]);
export const storedCredentialSchema = envelopeSchema.extend({ rotation: rotationSchema.optional() });
export const rotatingTokenFields = {
  refresh_token: z
    .string()
    .regex(/^xoxe-[A-Za-z0-9-]+$/)
    .max(4096)
    .optional(),
  expires_in: z.number().int().positive().max(86400).optional(),
};
export function validRotation(value: { refresh_token?: string | undefined; expires_in?: number | undefined }) {
  return (value.refresh_token === undefined) === (value.expires_in === undefined);
}

export function slackCredentialCipher(input: z.infer<typeof ringSchema>) {
  const ring = ringSchema.parse(input);
  if (!ring.keys[ring.activeKeyId]) throw new Error('slack-credential-key-unavailable');
  const aad = (input: SlackCredentialBinding) => {
    const binding = bindingSchema.parse(input);
    return Buffer.from(
      JSON.stringify([
        'slack',
        binding.workspaceId,
        binding.installationId,
        binding.generation,
        binding.kind,
        ...(binding.kind === 'user' ? [binding.identityId, binding.membershipId, binding.slackUserId] : []),
      ]),
    );
  };
  return {
    encrypt(binding: SlackCredentialBinding, token: string) {
      try {
        const nonce = randomBytes(12);
        const cipher = createCipheriv(
          'aes-256-gcm',
          Buffer.from(z.string().parse(ring.keys[ring.activeKeyId]), 'hex'),
          nonce,
        );
        cipher.setAAD(aad(binding));
        const ciphertext = Buffer.concat([
          cipher.update(z.string().min(1).max(4096).parse(token), 'utf8'),
          cipher.final(),
        ]);
        return {
          keyId: ring.activeKeyId,
          nonce: nonce.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        };
      } catch {
        throw new Error('slack-credential-unavailable');
      }
    },
    decrypt(binding: SlackCredentialBinding, value: unknown) {
      try {
        const envelope = storedCredentialSchema.parse(value);
        if (envelope.rotation && (envelope.rotation.state !== 'ready' || envelope.rotation.expiresAt <= Date.now()))
          throw new Error();
        const cipher = createDecipheriv(
          'aes-256-gcm',
          Buffer.from(z.string().parse(ring.keys[envelope.keyId]), 'hex'),
          Buffer.from(envelope.nonce, 'base64'),
        );
        cipher.setAAD(aad(binding));
        cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        return Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]).toString(
          'utf8',
        );
      } catch {
        throw new Error('slack-credential-unavailable');
      }
    },
  };
}

export function encryptSlackToken(
  cipher: ReturnType<typeof slackCredentialCipher>,
  binding: SlackCredentialBinding,
  token: string,
  rotation: { refresh_token?: string | undefined; expires_in?: number | undefined },
) {
  if (!validRotation(rotation)) throw new Error('slack-token-invalid');
  const envelope = cipher.encrypt(binding, token);
  return rotation.refresh_token && rotation.expires_in
    ? {
        ...envelope,
        rotation: {
          state: 'ready' as const,
          expiresAt: Date.now() + rotation.expires_in * 1000,
          refresh: cipher.encrypt(binding, rotation.refresh_token),
        },
      }
    : envelope;
}
