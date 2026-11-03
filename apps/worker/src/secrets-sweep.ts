import { z } from 'zod';
import { createConversationRequests, secretRequestSettlement } from '@tulipfarm/conversations/requests';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createSecretRequests, createSecrets, type SecretsRuntime } from '@tulipfarm/secrets';

const PAGES_PER_RUN = 20;

/**
 * Expires overdue secret requests, resuming their chats, and deletes expired secrets (P11, P46). It runs even
 * when `SECRETS_ENABLED` is off, so turning the feature off never keeps an expired value.
 */
export function createSecretsSweep(
  runtime: SecretsRuntime,
  discover: (after: string | null) => Promise<string[]>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const enabled = z.enum(['true', 'false']).parse(env.SECRETS_ENABLED ?? 'false') === 'true';
  const secrets = createSecrets({ runtime, keyring: () => integrationCredentialKeyring(env), enabled });
  const requests = createSecretRequests(secrets, {
    settle: secretRequestSettlement(createConversationRequests(runtime)),
  });
  let cursor: string | null = null;
  return async (log: (workspaceId: string, error: unknown) => void) => {
    const failures: unknown[] = [];
    for (let page = 0; page < PAGES_PER_RUN; page++) {
      const workspaces = await discover(cursor);
      if (!workspaces.length) {
        cursor = null;
        break;
      }
      for (const workspaceId of workspaces) {
        cursor = workspaceId;
        try {
          await requests.sweep(workspaceId);
        } catch (error) {
          log(workspaceId, error);
          failures.push(error);
        }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Secrets sweep failed');
  };
}
