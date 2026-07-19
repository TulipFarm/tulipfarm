import type { IntegrationManifest } from "@tulipfarm/soul";

/**
 * Secret env handling for integration connections. connection.yaml lives in the soul git repo
 * (committed and pushed to the user's upstream), so secret-flagged env values must never be
 * written there in plaintext. Instead they are stored in the encrypted secrets store and the
 * file carries an opaque `secret://<key>` reference, resolved back at point-of-use (MCP
 * transport start, ingress HMAC verification).
 */

export const SECRET_REF_PREFIX = "secret://";

/** The subset of SecretsService the connection env helpers need (narrow for testability). */
export interface ConnectionSecretStore {
  get(key: string): Promise<string>;
  set(key: string, plaintext: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<Array<{ key: string }>>;
}

export function integrationSecretKey(integrationName: string, envName: string): string {
  return `integration.${integrationName}.${envName}`;
}

export function isSecretRef(value: string): boolean {
  return value.startsWith(SECRET_REF_PREFIX);
}

/** Env var names the manifest declares as secret (required_env `secret: true` + the OAuth token). */
function secretEnvNames(manifest: IntegrationManifest): Set<string> {
  const names = new Set<string>();
  for (const field of manifest.required_env ?? []) {
    if (field.secret) names.add(field.name);
  }
  // The OAuth access token is always a secret, whether or not it is listed in required_env.
  const tf = manifest.oauth?.["x-tulipfarm"];
  if (tf) {
    names.add(tf.token_env);
    names.add(tf.client_secret_env);
  }
  return names;
}

/**
 * Replace secret-flagged env values with `secret://` references, persisting each value to the
 * secrets store. Values that are already references pass through untouched (reconnect flows
 * resubmit the stored form). Returns a new object safe to write to connection.yaml.
 */
export async function sealConnectionEnv(
  integrationName: string,
  manifest: IntegrationManifest,
  env: Record<string, string>,
  secrets: ConnectionSecretStore
): Promise<Record<string, string>> {
  const secretNames = secretEnvNames(manifest);
  const sealed: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!secretNames.has(name) || isSecretRef(value) || value === "") {
      sealed[name] = value;
      continue;
    }
    const key = integrationSecretKey(integrationName, name);
    await secrets.set(key, value);
    sealed[name] = `${SECRET_REF_PREFIX}${key}`;
  }
  return sealed;
}

/**
 * Resolve `secret://` references back to plaintext for runtime use. Plain values pass through,
 * so pre-existing plaintext connection.yaml files keep working. A missing secret throws — the
 * callers (MCP connect, ingress verify) already treat failures as "not connected".
 */
export async function resolveConnectionEnv(
  env: Record<string, string>,
  secrets: ConnectionSecretStore
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    resolved[name] = isSecretRef(value)
      ? await secrets.get(value.slice(SECRET_REF_PREFIX.length))
      : value;
  }
  return resolved;
}

/** Resolve a single `secret://` value; undefined when missing (plaintext passes through). */
export async function resolveSecretRef(
  value: string,
  secrets: ConnectionSecretStore
): Promise<string | undefined> {
  if (!isSecretRef(value)) return value;
  try {
    return await secrets.get(value.slice(SECRET_REF_PREFIX.length));
  } catch {
    return undefined;
  }
}

/** Remove every stored secret belonging to an integration (uninstall cleanup). */
export async function deleteConnectionSecrets(
  integrationName: string,
  secrets: ConnectionSecretStore
): Promise<void> {
  const prefix = `integration.${integrationName}.`;
  for (const meta of await secrets.list()) {
    if (meta.key.startsWith(prefix)) await secrets.delete(meta.key);
  }
}
