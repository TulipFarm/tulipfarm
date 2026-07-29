export const BOT_GIT_NAME = process.env.BOT_GIT_NAME ?? "tulipfarm-bot";
export const BOT_GIT_EMAIL = process.env.BOT_GIT_EMAIL ?? "tulipfarmhq@gmail.com";

/**
 * Single-deployment business scope. TulipFarm runs one business per deployment today, so every
 * principal, Run, and worker lease belongs to the same business. It exists as a named constant
 * rather than an implicit blank so authority checks in `@tulipfarm/authz` — which are
 * business-scoped by contract — never compare an empty string against an empty string.
 *
 * It lives here rather than in `apps/api` because the API and the worker must agree on it and
 * an app may not import another app.
 */
export const DEPLOYMENT_BUSINESS_ID = process.env.BUSINESS_ID ?? "tulipfarm-local";
