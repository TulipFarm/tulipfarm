import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';

export function googleOperations(runtime: Parameters<typeof createGoogleOperations>[0]['runtime']) {
  return createGoogleOperations({
    runtime,
    integrations: createGoogleWorkspaceService({ runtime, keyring: integrationCredentialKeyring() }),
  });
}
