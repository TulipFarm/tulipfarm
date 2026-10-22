import { Pool } from 'pg';
import { createDevSessions } from '@tulipfarm/api/dev-session';
import { createGovernanceService } from '@tulipfarm/workspaces/governance';
import { emailDeliveryKeys } from '@tulipfarm/workspaces/email-delivery';
import { workspaceRuntime, commonCompatibility, type WorkspaceRuntime } from '@tulipfarm/workspaces/storage';
import { createMigrationCredentialResolver } from '@tulipfarm/workspaces/capabilities';
import { webOrigin } from './env.ts';
import type { Manifest } from './manifest.ts';
import type { Random } from './random.ts';

export type SeedContext = {
  identity: Pool;
  runtime: WorkspaceRuntime;
  sessions: ReturnType<typeof createDevSessions>;
  governance: ReturnType<typeof createGovernanceService>;
  migrationCredential: ReturnType<typeof createMigrationCredentialResolver>;
  manifest: Manifest;
  random: Random;
  log: (message: string) => void;
  close: () => Promise<void>;
};

export function createSeedContext(manifest: Manifest, random: Random, log: (message: string) => void): SeedContext {
  const identity = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=app', max: 4 });
  const registry = new Pool({ connectionString: process.env.WORKSPACE_MIGRATION_REGISTRY_DATABASE_URL, max: 2 });
  identity.on('error', () => undefined);
  registry.on('error', () => undefined);
  const runtime = workspaceRuntime(identity);
  return {
    identity,
    runtime,
    manifest,
    random,
    log,
    sessions: createDevSessions(identity),
    governance: createGovernanceService({
      runtime,
      identity,
      compatibility: commonCompatibility,
      emailDelivery: { keys: emailDeliveryKeys(), webOrigin: webOrigin() },
    }),
    migrationCredential: createMigrationCredentialResolver(registry),
    async close() {
      await runtime.close();
      await Promise.allSettled([identity.end(), registry.end()]);
    },
  };
}
