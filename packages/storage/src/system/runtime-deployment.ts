import type { Queryable } from "../ports";

export interface RuntimeDeploymentConfig {
  readonly businessId: string;
  /** Optional assertion, not an ownership credential or a request to replace an identity. */
  readonly installationId?: string;
}

/** Server-only composition metadata. Neither identity grants membership or managed-service access. */
export interface RuntimeDeploymentContext {
  readonly hostingAuthority: "independent";
  readonly businessId: string;
  readonly installationId: string;
}

export class RuntimeDeploymentConfigError extends Error {
  readonly name = "RuntimeDeploymentConfigError";
}

export class RuntimeIdentityMismatchError extends Error {
  readonly name = "RuntimeIdentityMismatchError";

  constructor(field: "BUSINESS_ID" | "RUNTIME_INSTALLATION_ID") {
    super(
      `${field} conflicts with the persisted runtime identity. Restore the matching configuration and database; the existing association has not been overwritten.`
    );
  }
}

export const RUNTIME_IDENTITY_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS deployment_runtime_identity (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    installation_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    business_id text NOT NULL CHECK (length(btrim(business_id)) > 0),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
];

interface RuntimeIdentityRow {
  installation_id: string;
  business_id: string;
}

/** Initialize after API migrations, before serving requests or starting worker loops. */
export async function initializeRuntimeDeployment(
  database: Queryable,
  config: RuntimeDeploymentConfig
): Promise<RuntimeDeploymentContext> {
  if (!config.businessId.trim() || config.businessId.includes("\0")) {
    throw new RuntimeDeploymentConfigError("BUSINESS_ID must be non-empty text");
  }
  if (
    config.installationId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.installationId)
  ) {
    throw new RuntimeDeploymentConfigError("RUNTIME_INSTALLATION_ID must be a UUID when supplied");
  }

  await database.query(
    `INSERT INTO deployment_runtime_identity (singleton, installation_id, business_id)
     VALUES (true, COALESCE($1::uuid, gen_random_uuid()), $2)
     ON CONFLICT (singleton) DO NOTHING`,
    [config.installationId ?? null, config.businessId]
  );
  // A separate statement sees a concurrent winner after ON CONFLICT waits for its commit.
  const result = await database.query<RuntimeIdentityRow>(
    `SELECT installation_id, business_id FROM deployment_runtime_identity WHERE singleton = true`
  );
  const identity = result.rows[0];
  if (!identity) throw new Error("Persisted runtime identity is unavailable");
  if (identity.business_id !== config.businessId) {
    throw new RuntimeIdentityMismatchError("BUSINESS_ID");
  }
  if (
    config.installationId !== undefined &&
    identity.installation_id !== config.installationId.toLowerCase()
  ) {
    throw new RuntimeIdentityMismatchError("RUNTIME_INSTALLATION_ID");
  }
  return Object.freeze({
    hostingAuthority: "independent",
    businessId: identity.business_id,
    installationId: identity.installation_id,
  });
}
