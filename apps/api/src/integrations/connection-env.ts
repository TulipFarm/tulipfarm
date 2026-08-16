import type { IntegrationManifest } from "@tulipfarm/soul";
import { authSecretEnvNames } from "@tulipfarm/soul";

/** Secrets in committed connection.yaml must be stored as `secret://` refs. */

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

/** Seals secret env values to `secret://` refs; missing optional secrets are omitted. */
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

/** Resolves `secret://` refs for runtime use; plaintext values pass through for migration. */
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
    // A missing or unreadable secret resolves to "unset"; callers gate on undefined.
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
