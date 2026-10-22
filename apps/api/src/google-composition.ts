import { Pool } from 'pg';
import { z } from 'zod';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import { createGoogleApproval } from '@tulipfarm/google-workspace/operation-approval';
import { createConfirmationCredentialResolver } from '@tulipfarm/workspaces/capabilities';
import { isFeatureEnabled } from '@tulipfarm/observability';

export function googleOperations(runtime: Parameters<typeof createGoogleOperations>[0]['runtime']) {
  return createGoogleOperations({
    runtime,
    integrations: createGoogleWorkspaceService({ runtime, keyring: integrationCredentialKeyring() }),
    calendarFeaturesEnabled: (workspaceId, userId) =>
      isFeatureEnabled('google-calendar-canvas', { id: userId }, { id: workspaceId }),
  });
}

export function googleConfirmation(runtime: Parameters<typeof createGoogleApproval>[0]['runtime']) {
  const connectionString = z.url().parse(process.env.WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL);
  const runtimeKey = z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .parse(process.env.WORKSPACE_RUNTIME_KEY);
  const confirmationKey = z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .parse(process.env.WORKSPACE_CONFIRMATION_KEY);
  if (runtimeKey.toLowerCase() === confirmationKey.toLowerCase())
    throw new Error('Workspace capability keys must be independent');
  if (
    decodeURIComponent(new URL(connectionString).username) ===
    decodeURIComponent(new URL(z.url().parse(process.env.DATABASE_URL)).username)
  )
    throw new Error('Confirmation registry requires a separate login');
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    options: '-c search_path=pg_catalog',
  });
  pool.on('error', () => undefined);
  const resolve = createConfirmationCredentialResolver(pool);
  return {
    approve: createGoogleApproval({
      runtime,
      resolveConfirmationCredential: async workspaceId => (await resolve(workspaceId)).connectionString,
    }),
    close: () => pool.end(),
  };
}
