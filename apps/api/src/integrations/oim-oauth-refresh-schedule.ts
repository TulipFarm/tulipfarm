import type { SecretsService } from "@tulipfarm/secrets";
import { oauth2ExpiresAtEnv, type SoulLoader } from "@tulipfarm/soul";
import type { ConnectionStore, PersistedConnection } from "@tulipfarm/storage";
import type { PgBoss } from "pg-boss";
import { credentialsExpireWithin, refreshOAuth2Credentials } from "./auth-broker";
import { oimCredentialsFromEnv, oimOAuthLegacyManifest, oimSlotEnv } from "./oim-oauth";

export const OIM_OAUTH_REFRESH_QUEUE = "oim-oauth-refresh";
export const OIM_OAUTH_REFRESH_CRON = "*/5 * * * *";
export const OIM_OAUTH_RENEWAL_WINDOW_SECONDS = 10 * 60;

type RefreshConnections = Pick<ConnectionStore, "listExpiring" | "updateHealth">;
type RefreshSecrets = Pick<SecretsService, "get" | "setMany">;
type InstalledOimManifest = NonNullable<
  NonNullable<ReturnType<SoulLoader["integrations"]["get"]>>["oimManifest"]
>;

export interface OimOAuthRefreshScheduleDeps {
  readonly businessId: string;
  readonly connections: RefreshConnections;
  readonly secrets: RefreshSecrets;
  readonly soulLoader: SoulLoader;
  readonly now?: () => Date;
  readonly fetchImpl?: typeof globalThis.fetch;
}

export interface OimOAuthRefreshResult {
  readonly connectionId: string;
  readonly status: "renewed" | "action_required" | "skipped";
}

function secretKey(reference: string): string {
  return reference.replace(/^secret:\/\//, "");
}

function manifestFor(
  soulLoader: SoulLoader,
  connection: PersistedConnection
):
  | {
      readonly manifest: InstalledOimManifest;
      readonly legacy: NonNullable<ReturnType<typeof oimOAuthLegacyManifest>>;
    }
  | undefined {
  for (const integration of soulLoader.integrations.values()) {
    const manifest = integration.oimManifest;
    if (
      manifest?.metadata.id === connection.integration.id &&
      Number(manifest.metadata.version.split(".", 1)[0]) === connection.integration.majorVersion
    ) {
      const legacy = oimOAuthLegacyManifest(manifest);
      if (legacy !== undefined) return { manifest, legacy };
    }
  }
  return undefined;
}

async function oauthEnv(
  secrets: RefreshSecrets,
  connection: PersistedConnection
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [slot, reference] of Object.entries(connection.secretBindings)) {
    env[oimSlotEnv(slot)] = await secrets.get(secretKey(reference));
  }
  return env;
}

async function markActionRequired(
  connections: RefreshConnections,
  connection: PersistedConnection,
  checkedAt: string
): Promise<void> {
  await connections.updateHealth(
    connection.businessId,
    connection.id,
    { status: "action_required", checkedAt },
    connection.expiresAt
  );
}

async function renewConnection(
  deps: OimOAuthRefreshScheduleDeps,
  connection: PersistedConnection,
  now: Date
): Promise<OimOAuthRefreshResult> {
  const checkedAt = now.toISOString();
  const oauth = manifestFor(deps.soulLoader, connection);
  const step = oauth?.legacy.auth?.[1];
  if (oauth === undefined || step?.kind !== "oauth2") {
    return { connectionId: connection.id, status: "skipped" };
  }

  try {
    const env = await oauthEnv(deps.secrets, connection);
    env[oauth2ExpiresAtEnv(step)] = connection.expiresAt ?? "";
    if (!credentialsExpireWithin(step, env, OIM_OAUTH_RENEWAL_WINDOW_SECONDS, now)) {
      return { connectionId: connection.id, status: "skipped" };
    }

    await deps.connections.updateHealth(
      connection.businessId,
      connection.id,
      { status: "expiring", checkedAt },
      connection.expiresAt
    );

    const refreshed = await refreshOAuth2Credentials(step, env, {
      now,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
    if (refreshed[step.token_env] === undefined) {
      await markActionRequired(deps.connections, connection, checkedAt);
      return { connectionId: connection.id, status: "action_required" };
    }

    const { slots, expiresAt } = oimCredentialsFromEnv(oauth.manifest, refreshed);
    const rotations: Record<string, string> = {};
    for (const [slot, value] of Object.entries(slots)) {
      const reference = connection.secretBindings[slot];
      if (reference === undefined) throw new Error(`missing OAuth credential slot: ${slot}`);
      if (env[oimSlotEnv(slot)] !== value) rotations[secretKey(reference)] = value;
    }
    await deps.secrets.setMany(rotations);
    await deps.connections.updateHealth(
      connection.businessId,
      connection.id,
      { status: "healthy", checkedAt },
      expiresAt
    );
    return { connectionId: connection.id, status: "renewed" };
  } catch {
    await markActionRequired(deps.connections, connection, checkedAt);
    return { connectionId: connection.id, status: "action_required" };
  }
}

/** Refreshes every active OIM OAuth Connection currently inside the renewal window. */
export async function refreshOimOAuthCredentials(
  deps: OimOAuthRefreshScheduleDeps
): Promise<readonly OimOAuthRefreshResult[]> {
  const now = (deps.now ?? (() => new Date()))();
  const expiresBefore = new Date(
    now.getTime() + OIM_OAUTH_RENEWAL_WINDOW_SECONDS * 1_000
  ).toISOString();
  const connections = await deps.connections.listExpiring(deps.businessId, expiresBefore);
  return await Promise.all(connections.map((connection) => renewConnection(deps, connection, now)));
}

/** Registers the five-minute OAuth renewal sweep in the API process, which owns its Secret store. */
export async function registerOimOAuthRefreshSchedule(
  boss: PgBoss,
  deps: OimOAuthRefreshScheduleDeps
): Promise<void> {
  await boss.createQueue(OIM_OAUTH_REFRESH_QUEUE);
  await boss.work(OIM_OAUTH_REFRESH_QUEUE, () => refreshOimOAuthCredentials(deps));
  await boss.schedule(OIM_OAUTH_REFRESH_QUEUE, OIM_OAUTH_REFRESH_CRON);
}
