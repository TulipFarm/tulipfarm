import {
  OIM_CONNECTION_REFRESH_CRON,
  OIM_CONNECTION_REFRESH_QUEUE,
  type OimConnectionRefreshSweepResult,
} from "@tulipfarm/integrations";
import type { PersistedConnection } from "@tulipfarm/storage";
import type { PgBoss } from "pg-boss";

const REFRESH_LOOKAHEAD_MS = 5 * 60 * 1000;

interface RefreshSweepDeps {
  readonly businessId: string;
  readonly connections: {
    listExpiring(
      businessId: string,
      expiresBefore: string
    ): Promise<readonly PersistedConnection[]>;
  };
  readonly refresh: (connection: PersistedConnection) => Promise<void>;
  readonly now?: () => Date;
  readonly log?: {
    error(obj: unknown, message?: string): void;
  };
}

export async function refreshExpiringOimConnections(
  deps: RefreshSweepDeps
): Promise<OimConnectionRefreshSweepResult> {
  const now = deps.now?.() ?? new Date();
  const expiresBefore = new Date(now.getTime() + REFRESH_LOOKAHEAD_MS).toISOString();
  const connections = await deps.connections.listExpiring(deps.businessId, expiresBefore);
  let refreshed = 0;
  let failed = 0;

  for (const connection of connections) {
    try {
      await deps.refresh(connection);
      refreshed += 1;
    } catch (error) {
      failed += 1;
      deps.log?.error({ error, connectionId: connection.id }, "OIM Connection refresh failed");
    }
  }

  return { examined: connections.length, refreshed, failed };
}

export async function registerOimConnectionRefreshSchedule(boss: PgBoss): Promise<void> {
  await boss.createQueue(OIM_CONNECTION_REFRESH_QUEUE, { policy: "exclusive" });
  await boss.schedule(OIM_CONNECTION_REFRESH_QUEUE, OIM_CONNECTION_REFRESH_CRON);
}
