import { z } from 'zod';
import declared from './database-connections.json' with { type: 'json' };

/**
 * The Postgres connections each deployed service holds per task, declared in database-connections.json. Code that
 * opens a pool takes its `max` from `databasePools`, and TulipFarm/deploy reads the same file to check a stack's
 * sizes at preview, so the startup check and the deployment check count the same pools.
 */
export type DatabasePool = keyof typeof declared.pools;
export type DatabaseService = keyof typeof declared.services;
export const databasePools: Readonly<Record<DatabasePool, number>> = declared.pools;
export const databaseServices = Object.keys(declared.services) as DatabaseService[];

const fleetSchema = z.partialRecord(
  z.enum(databaseServices),
  z.strictObject({
    tasks: z.int().nonnegative(),
    maxPools: z.int().min(1).max(100).optional(),
    connectionsPerPool: z.int().min(1).max(20).optional(),
  }),
);
/** Each service's most tasks and, for services with workspace pools, its workspace pool limits. */
export type DatabaseConnectionFleet = z.infer<typeof fleetSchema>;

/** Most connections every task of the fleet holds at once: its declared pools plus its workspace pools. */
export function fleetConnections(fleet: DatabaseConnectionFleet) {
  let total = 0;
  for (const service of databaseServices) {
    const entry = fleet[service];
    if (!entry) continue;
    const { workspaceRuntimes, pools } = declared.services[service];
    const workspace =
      (entry.maxPools ?? declared.workspaceDefaults.maxPools) *
      (entry.connectionsPerPool ?? declared.workspaceDefaults.connectionsPerPool);
    const perTask = pools.reduce((sum, pool) => sum + databasePools[pool as DatabasePool], 0);
    total += entry.tasks * (perTask + workspaceRuntimes * workspace);
  }
  return total;
}

/** The fleet a hosted deployment declares in DATABASE_CONNECTION_FLEET, or undefined when it declares none. */
export function databaseConnectionFleet(env: NodeJS.ProcessEnv = process.env) {
  const value = env.DATABASE_CONNECTION_FLEET?.trim();
  if (!value) return undefined;
  try {
    return fleetSchema.parse(JSON.parse(value));
  } catch {
    throw new Error('DATABASE_CONNECTION_FLEET must map deployed services to their tasks');
  }
}
