import {
  initializeRuntimeDeployment,
  type RuntimeDeploymentConfig,
  type RuntimeDeploymentContext,
} from "@tulipfarm/storage";
import type { Queryable } from "../db";
import { runPgMigrations } from "../pg-migrate";

/** Complete durable deployment initialization before any business-facing boot work. */
export async function initializeApiDeployment(
  database: Queryable,
  config: RuntimeDeploymentConfig
): Promise<RuntimeDeploymentContext> {
  await runPgMigrations(database, (code) => {
    throw new Error(`Runtime deployment migrations failed (exit ${code})`);
  });
  return initializeRuntimeDeployment(database, config);
}
