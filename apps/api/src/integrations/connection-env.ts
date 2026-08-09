import type { IntegrationManifest } from "@tulipfarm/soul";
import { authSecretEnvNames } from "@tulipfarm/soul";

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

/** Raised when a submitted value is a reference to a secret this integration does not own. */
export class ForeignSecretRefError extends Error {
  constructor(envName: string) {
    super(`${envName} may not reference another secret`);
    this.name = "ForeignSecretRefError";
  }
}

/**
 * Replace secret-flagged env values with `secret://` references, persisting each value to the
 * secrets store. Values that are already references pass through untouched (reconnect flows
 * resubmit the stored form). Returns a new object safe to write to connection.yaml.
 *
 * A reference is only honoured when it names *this* integration's own key for *that* env var,
 * which is the only reference a legitimate resubmission can carry. Accepting any other one would
 * turn connect into a read primitive for the whole secrets store: env values are resolved and
 * templated into the URLs the auth broker hands back (`{GITHUB_APP_SLUG}` and friends), so
 * `secret://some-other-key` would come straight back to the caller in a redirect. The secrets API
 * deliberately never returns values, and this must not become the way around that.
 */
export async function sealConnectionEnv(
  integrationName: string,
  manifest: IntegrationManifest,
  env: Record<string, string>,
  secrets: ConnectionSecretStore
): Promise<Record<string, string>> {
  const secretNames = authSecretEnvNames(manifest);
  const sealed: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const key = integrationSecretKey(integrationName, name);
    if (isSecretRef(value)) {
      if (value.slice(SECRET_REF_PREFIX.length) !== key) {
        throw new ForeignSecretRefError(name);
      }
      sealed[name] = value;
      continue;
    }
    if (!secretNames.has(name) || value === "") {
      sealed[name] = value;
      continue;
    }
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
