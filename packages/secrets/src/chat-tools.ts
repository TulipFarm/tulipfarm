import { normalizeDestinations, secretsRequestCallSchema, type SecretRequestInput } from './contracts.ts';
import type { SecretRequests } from './requests.ts';
import type { Secrets, SecretTransaction } from './service.ts';

const refused = (error: string, instruction: string) => ({ ok: false as const, result: { error, instruction } });

/**
 * The `secrets.request` and `secrets.list` chat tools for the conversation runtime. Neither reads or returns a
 * value, and neither accepts a placement at use time (P16).
 */
export function chatSecretTools(secrets: Pick<Secrets, 'capabilities'>, requests: SecretRequests) {
  return {
    enabled: () => secrets.capabilities().enabled,

    /** Checks a `secrets.request` call before the form is created, so a bad call is answered without pausing. */
    prepare(call: unknown) {
      if (!secrets.capabilities().enabled)
        return refused(
          'secrets-unavailable',
          'Secrets are turned off in this workspace. Tell the member, and do not ask for the secret in chat.',
        );
      const parsed = secretsRequestCallSchema.safeParse(call);
      if (!parsed.success)
        return refused(
          'invalid-secret-request',
          'The request was not valid. Fix the fields or destinations and call secrets.request once more.',
        );
      try {
        normalizeDestinations(parsed.data.destinations);
      } catch {
        return refused(
          'invalid-destination',
          'Each destination must be a public host name or an https endpoint. Fix it and call secrets.request once more.',
        );
      }
      const { tool: _tool, ...request } = parsed.data;
      return { ok: true as const, prompt: request.purpose, request };
    },

    async create(
      tx: SecretTransaction,
      input: {
        id: string;
        membershipId: string;
        origin: { kind: 'chat'; conversationId: string; turnId: string; conversationRequestId: string };
        request: unknown;
      },
    ) {
      await requests.create(tx, {
        id: input.id,
        membershipId: input.membershipId,
        origin: input.origin,
        // Parsed again by `requests.create`.
        request: input.request as SecretRequestInput,
      });
      return { status: 'awaiting-input' as const, secretRequestId: input.id };
    },

    async list(tx: SecretTransaction, membershipId: string, conversationId: string) {
      const references = await requests.references(tx, membershipId, { kind: 'chat', conversationId });
      return {
        references,
        instruction: references.length
          ? 'These are references, never values. An expired or suspended secret cannot be used; ask the member before requesting it again.'
          : 'This chat holds no secrets. Call secrets.request once if a call needs one.',
      };
    },
  };
}
export type ChatSecretTools = ReturnType<typeof chatSecretTools>;
