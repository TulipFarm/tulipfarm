import type { SecretsRuntime } from '@tulipfarm/secrets';
import { workspaceSchemaPending } from '@tulipfarm/workspace-storage/runtime';
import { secretsServices } from './secrets-composition.ts';

const PAGES_PER_RUN = 20;

/**
 * Expires overdue secret requests, resuming their chats, and deletes expired secrets (P11, P46). It runs even
 * when the encryption key is missing, so losing the key never keeps an expired value.
 */
export function createSecretsSweep(
  runtime: SecretsRuntime,
  discover: (after: string | null) => Promise<string[]>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const { requests } = secretsServices(runtime, env);
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
          // A workspace still waiting for this release's migrations is swept on a later run.
          if (workspaceSchemaPending(error)) continue;
          log(workspaceId, error);
          failures.push(error);
        }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Secrets sweep failed');
  };
}
