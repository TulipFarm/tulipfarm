import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import { isFeatureEnabled } from '@tulipfarm/observability';

export function googleOperations(runtime: Parameters<typeof createGoogleOperations>[0]['runtime']) {
  return createGoogleOperations({
    runtime,
    integrations: createGoogleWorkspaceService({ runtime, keyring: integrationCredentialKeyring() }),
    calendarFeaturesEnabled: (workspaceId, userId) =>
      isFeatureEnabled('google-calendar-canvas', { id: userId }, { id: workspaceId }),
  });
}
