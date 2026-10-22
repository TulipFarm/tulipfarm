import { encryptEnvelope, decryptEnvelope, encryptedEnvelopeSchema as envelopeSchema } from './encrypted-envelope.ts';
import { z } from 'zod';
import type { EmailDeliveryKeys } from './email-delivery.ts';

const binding = (workspaceId: string, invitationId: string, keyId: string) =>
  Buffer.from(
    JSON.stringify([
      'invitation-copy',
      1,
      z.uuid().parse(workspaceId).toLowerCase(),
      z.uuid().parse(invitationId).toLowerCase(),
      keyId,
    ]),
  );

export function encryptInvitationCopy(workspaceId: string, invitationId: string, url: string, keys: EmailDeliveryKeys) {
  return encryptEnvelope(z.url().parse(url), keys, binding(workspaceId, invitationId, keys.keyId));
}

export function decryptInvitationCopy(
  workspaceId: string,
  invitationId: string,
  input: unknown,
  keys: EmailDeliveryKeys,
) {
  try {
    const envelope = envelopeSchema.parse(input);
    const key = envelope.keyId === keys.keyId ? keys.key : keys.previous.get(envelope.keyId);
    if (!key) throw new Error('Missing key');
    return z.url().parse(decryptEnvelope(envelope, key, binding(workspaceId, invitationId, envelope.keyId)));
  } catch {
    throw new Error('Invitation copy unavailable');
  }
}
