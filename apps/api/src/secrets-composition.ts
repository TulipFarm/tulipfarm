import { z } from 'zod';
import { createConversationRequests, secretRequestSettlement } from '@tulipfarm/conversations/requests';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createSecretRequests, createSecrets, type SecretsRuntime } from '@tulipfarm/secrets';

/** Secrets share the integration credential keyring; it loads lazily so a missing key only disables them. */
export function secretsServices(runtime: SecretsRuntime, env: NodeJS.ProcessEnv = process.env) {
  const enabled = z.enum(['true', 'false']).parse(env.SECRETS_ENABLED ?? 'false') === 'true';
  const secrets = createSecrets({ runtime, keyring: () => integrationCredentialKeyring(env), enabled });
  const requests = createSecretRequests(secrets, {
    settle: secretRequestSettlement(createConversationRequests(runtime)),
  });
  return { secrets, requests };
}
