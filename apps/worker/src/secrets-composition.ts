import { z } from 'zod';
import { apiCallPrivateHosts } from '@tulipfarm/api-calls';
import { createConversationRequests, secretRequestSettlement } from '@tulipfarm/conversations/requests';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import type { TaskSecretsAccess } from '@tulipfarm/agents/task-runtime';
import { heldSecrets } from '@tulipfarm/secrets/send';
import {
  chatSecretTools,
  taskSecretTools,
  createSecretRequests,
  createSecrets,
  type SecretsRuntime,
} from '@tulipfarm/secrets';

/** Secrets share the integration credential keyring; it loads lazily so a missing key only disables them. */
export function secretsServices(runtime: SecretsRuntime, env: NodeJS.ProcessEnv = process.env) {
  const enabled = z.enum(['true', 'false']).parse(env.SECRETS_ENABLED ?? 'false') === 'true';
  const secrets = createSecrets({
    runtime,
    keyring: () => integrationCredentialKeyring(env),
    enabled,
    privateHosts: apiCallPrivateHosts(env),
  });
  const requests = createSecretRequests(secrets, {
    settle: secretRequestSettlement(createConversationRequests(runtime)),
  });
  return { secrets, requests, chat: chatSecretTools(secrets, requests), task: taskSecretTools(secrets, requests) };
}

/** What task runs use: the owner's secret forms, the secrets the run holds and the operator's private hosts. */
export function taskSecretsAccess(services: ReturnType<typeof secretsServices>): TaskSecretsAccess {
  return {
    tools: services.task,
    privateHosts: services.secrets.privateHosts,
    ...(services.secrets.capabilities().enabled
      ? {
          held: holder => {
            const held = heldSecrets(services.secrets, services.requests, holder);
            return { resolve: held.resolve, recordUse: (id, url) => held.recordUse(id, url, 'api.request') };
          },
        }
      : {}),
  };
}
