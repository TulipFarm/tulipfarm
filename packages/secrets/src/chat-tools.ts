import { normalizeDestinations, secretsRequestCallSchema, type SecretRequestInput } from './contracts.ts';
import type { SecretRequests } from './requests.ts';
import type { Secrets, SecretTransaction } from './service.ts';

const refused = (error: string, instruction: string) => ({ ok: false as const, result: { error, instruction } });

type ToolSecrets = Pick<Secrets, 'capabilities'> & { privateHosts?: Secrets['privateHosts'] };

function prepareRequest(secrets: ToolSecrets, call: unknown) {
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
    normalizeDestinations(parsed.data.destinations, secrets.privateHosts);
  } catch {
    return refused(
      'invalid-destination',
      'Each destination must be a public host name or an https endpoint. Fix it and call secrets.request once more.',
    );
  }
  const { tool: _tool, ...request } = parsed.data;
  return { ok: true as const, prompt: request.purpose, request };
}

/**
 * The `secrets.request` and `secrets.list` chat tools for the conversation runtime. Neither reads or returns a
 * value, and neither accepts a placement at use time (P16).
 */
export function chatSecretTools(secrets: ToolSecrets, requests: SecretRequests) {
  return {
    enabled: () => secrets.capabilities().enabled,

    /** Checks a `secrets.request` call before the form is created, so a bad call is answered without pausing. */
    prepare: (call: unknown) => prepareRequest(secrets, call),

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

/**
 * The `secrets.request` and `secrets.list` tools in a task run. The form goes only to the task's owner, the run waits
 * for the answer, and a value kept for "only this chat" lasts for this run (P21).
 */
export function taskSecretTools(secrets: ToolSecrets, requests: SecretRequests) {
  return {
    enabled: () => secrets.capabilities().enabled,
    prepare: (call: unknown) => prepareRequest(secrets, call),

    async create(
      tx: SecretTransaction,
      input: {
        id: string;
        membershipId: string;
        origin: { kind: 'task'; taskId: string; runId: string };
        request: unknown;
      },
    ) {
      await requests.create(tx, {
        id: input.id,
        membershipId: input.membershipId,
        origin: input.origin,
        request: input.request as SecretRequestInput,
      });
      return { status: 'awaiting-input' as const, secretRequestId: input.id };
    },

    /** The answer to a request this run made, or `waiting`; `undefined` when the run has not made it yet. */
    async outcome(tx: Parameters<SecretRequests['outcome']>[0], workspaceId: string, id: string) {
      const outcome = await requests.outcome(tx, workspaceId, id);
      if (!outcome || outcome.status === 'waiting') return outcome;
      return {
        ...outcome,
        instruction:
          'This is the task owner’s answer to your secret request. Use only the returned references; you never see values. If declined, cancelled or expired, continue without the secret and do not ask for it again in this run.',
      };
    },

    /** Cancels the run's open forms and deletes the secrets kept only for it, when the run ends. */
    endRun: (tx: SecretTransaction, origin: { kind: 'task'; taskId: string; runId: string }) =>
      requests.endOrigin(tx, origin),

    async list(tx: SecretTransaction, membershipId: string, origin: { kind: 'task'; taskId: string; runId: string }) {
      const references = await requests.references(tx, membershipId, origin);
      return {
        references,
        instruction: references.length
          ? 'These are references, never values. An expired or suspended secret cannot be used; report it instead of requesting it again.'
          : 'This task run holds no secrets. Call secrets.request once if a call needs one; the task waits for its owner.',
      };
    },
  };
}
export type TaskSecretTools = ReturnType<typeof taskSecretTools>;
