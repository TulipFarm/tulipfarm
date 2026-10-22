import { Pool } from 'pg';
import { z } from 'zod';
import { createTableApprovalResolver } from '@tulipfarm/tables/conversation-approvals';
import { createConfirmationCredentialResolver } from './capabilities.ts';
import { credentialKey } from './credentials.ts';
import type { WorkspaceRuntime } from './storage.ts';
import { createAtlassianApproval } from '@tulipfarm/atlassian/operation-approval';

export function createWorkspaceTableConfirmation(runtime: WorkspaceRuntime) {
  if (credentialKey('runtime').key.equals(credentialKey('confirmation').key)) {
    throw new Error('Workspace capability keys must be independent');
  }
  const connectionString = z.url().parse(process.env.WORKSPACE_CONFIRMATION_REGISTRY_DATABASE_URL);
  if (
    decodeURIComponent(new URL(connectionString).username) ===
    decodeURIComponent(new URL(z.url().parse(process.env.DATABASE_URL)).username)
  ) {
    throw new Error('Confirmation registry requires a separate login');
  }
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    options: '-c search_path=pg_catalog',
  });
  pool.on('error', () => undefined);
  const resolve = createConfirmationCredentialResolver(pool);
  const options = {
    runtime,
    resolveConfirmationCredential: async (workspaceId: string) => (await resolve(workspaceId)).connectionString,
  };
  return {
    resolveConfirmationCredential: options.resolveConfirmationCredential,
    approvals: createTableApprovalResolver(options),
    atlassian: createAtlassianApproval(options),
    close: () => pool.end(),
  };
}
