export const OIM_CONNECTION_REFRESH_QUEUE = "oim-connection-refresh";
export const OIM_CONNECTION_REFRESH_CRON = "* * * * *";

export interface OimConnectionRefreshSweepResult {
  readonly examined: number;
  readonly refreshed: number;
  readonly failed: number;
}
