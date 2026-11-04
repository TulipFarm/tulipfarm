import { apiCallPrivateHosts } from '@tulipfarm/api-calls';
import { createConversationRequests, secretRequestSettlement } from '@tulipfarm/conversations/requests';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createSecretRequests, createSecrets, type SecretsRuntime } from '@tulipfarm/secrets';

/** Secrets share the integration credential keyring; it loads lazily so a missing key only disables them. */
export function secretsServices(runtime: SecretsRuntime, env: NodeJS.ProcessEnv = process.env) {
  const secrets = createSecrets({
    runtime,
    keyring: () => integrationCredentialKeyring(env),
    privateHosts: apiCallPrivateHosts(env),
  });
  const requests = createSecretRequests(secrets, {
    settle: secretRequestSettlement(createConversationRequests(runtime)),
  });
  return { secrets, requests };
}
