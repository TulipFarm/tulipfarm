import { z } from 'zod';
import type { IntegrationKeyring } from '@tulipfarm/integrations';
import {
  decryptEnvelope,
  encryptedEnvelopeSchema,
  encryptEnvelope,
} from '@tulipfarm/workspace-storage/encrypted-envelope';
import { githubEventIdSchema } from './event-contracts.ts';
import { githubEventInputByteLimit, githubNormalizedEventSchema, githubPendingPullRequestSchema } from './events.ts';

export const githubStoredEventSchema = z.union([githubNormalizedEventSchema, githubPendingPullRequestSchema]);
export type GitHubStoredEvent = z.infer<typeof githubStoredEventSchema>;
const bindingSchema = z.strictObject({
  appId: githubEventIdSchema,
  deliveryId: z.uuid().transform(value => value.toLowerCase()),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  event: z.string().regex(/^[a-z_]{1,64}$/),
});
type Binding = z.infer<typeof bindingSchema>;
const key = z.string().regex(/^[a-f0-9]{64}$/i);

export function githubEventContent(ring: IntegrationKeyring) {
  const aad = (binding: Binding) => Buffer.from(JSON.stringify(['github-event-content', bindingSchema.parse(binding)]));
  function serialize(value: unknown) {
    const body = JSON.stringify(githubStoredEventSchema.parse(value));
    if (Buffer.byteLength(body) > githubEventInputByteLimit) throw new Error('github-event-content-too-large');
    return body;
  }
  return {
    encrypt(binding: Binding, value: GitHubStoredEvent) {
      return encryptEnvelope(
        serialize(value),
        { keyId: ring.activeKeyId, key: Buffer.from(key.parse(ring.keys[ring.activeKeyId]), 'hex') },
        aad(binding),
      );
    },
    decrypt(binding: Binding, input: unknown): GitHubStoredEvent {
      const envelope = encryptedEnvelopeSchema.parse(input);
      if (Buffer.byteLength(envelope.ciphertext) > 44000) throw new Error('github-event-content-too-large');
      const plaintext = decryptEnvelope(
        envelope,
        Buffer.from(key.parse(ring.keys[envelope.keyId]), 'hex'),
        aad(binding),
      );
      if (Buffer.byteLength(plaintext) > githubEventInputByteLimit) throw new Error('github-event-content-too-large');
      return githubStoredEventSchema.parse(JSON.parse(plaintext));
    },
  };
}
