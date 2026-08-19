export const BOT_GIT_NAME = process.env.BOT_GIT_NAME ?? "tulipfarm-bot";
export const BOT_GIT_EMAIL = process.env.BOT_GIT_EMAIL ?? "tulipfarmhq@gmail.com";

/** Shared single-deployment business id; authz comparisons must never rely on empty strings. */
export const DEPLOYMENT_BUSINESS_ID = process.env.BUSINESS_ID ?? "tulipfarm-local";

/**
 * The identity a Routine State acts as. There is no participant behind an autonomous Routine, and
 * none is invented — it is deliberately not a `users` row, so it can never be mistaken for a
 * person. Shared so the executor and the Knowledge access gate cannot drift on the spelling.
 */
export const ROUTINE_SERVICE_PRINCIPAL_ID = "service:routine-executor";

export type { PgPoolTuning } from "./pg-pool";
export {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  DEFAULT_PG_POOL_MAX,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  pgPoolTuning,
} from "./pg-pool";
