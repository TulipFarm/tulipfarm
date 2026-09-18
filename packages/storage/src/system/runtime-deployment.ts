import type { Queryable } from "../ports";

export interface RuntimeDeploymentConfig {
  readonly hostingAuthority?: string;
  readonly businessId: string;
  /** Optional assertion, not an ownership credential or a request to replace an identity. */
  readonly installationId?: string;
}

/** Server-only composition metadata. Neither identity grants membership or managed-service access. */
export interface RuntimeDeploymentContext {
  readonly hostingAuthority: "independent" | "tulipfarm";
  readonly businessId: string;
  readonly installationId: string;
}

export class RuntimeDeploymentConfigError extends Error {
  readonly name = "RuntimeDeploymentConfigError";
}

export class RuntimeIdentityMismatchError extends Error {
  readonly name = "RuntimeIdentityMismatchError";

  constructor(field: "BUSINESS_ID" | "RUNTIME_INSTALLATION_ID" | "RUNTIME_HOSTING_AUTHORITY") {
    super(
      `${field} conflicts with the persisted runtime identity. Restore the matching configuration and database; the existing association has not been overwritten.`
    );
  }
}

/** Only conformance tests can supply trust until the hosted identity protocol exists. */
export interface RuntimeDeploymentTestTrust {
  verifyIdentity(identity: Readonly<{ businessId: string; installationId: string }>): Promise<void>;
}

export class RuntimeDeploymentTrustUnavailableError extends Error {
  readonly name = "RuntimeDeploymentTrustUnavailableError";

  constructor() {
    super("Hosted identity verification is unavailable. No ready runtime has been started.");
  }
}

const validatedContexts = new WeakSet<RuntimeDeploymentContext>();

export function runtimeDeploymentConfigFromEnv(
  businessId: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): RuntimeDeploymentConfig {
  return {
    businessId,
    hostingAuthority: env.RUNTIME_HOSTING_AUTHORITY,
    installationId: env.RUNTIME_INSTALLATION_ID || undefined,
  };
}

function hostingAuthority(value: string | undefined): RuntimeDeploymentContext["hostingAuthority"] {
  if (value === undefined || value === "" || value === "independent") return "independent";
  if (value === "tulipfarm") return "tulipfarm";
  throw new RuntimeDeploymentConfigError(
    "RUNTIME_HOSTING_AUTHORITY must be independent or tulipfarm; unset it for independent hosting."
  );
}

/** Partial independent assemblies remain supported; hosted assemblies must use initialized context. */
export function runtimeDeploymentAllowsIndependentSetup(
  context?: RuntimeDeploymentContext
): boolean {
  const configured = hostingAuthority(process.env.RUNTIME_HOSTING_AUTHORITY);
  if (context && !validatedContexts.has(context)) {
    throw new RuntimeDeploymentConfigError("Runtime deployment context has not been initialized.");
  }
  if (context && process.env.RUNTIME_HOSTING_AUTHORITY && configured !== context.hostingAuthority) {
    throw new RuntimeIdentityMismatchError("RUNTIME_HOSTING_AUTHORITY");
  }
  if ((context?.hostingAuthority ?? configured) === "tulipfarm") {
    if (!context || process.env.NODE_ENV !== "test") {
      throw new RuntimeDeploymentConfigError(
        "Hosted operation is unavailable: this release has no production hosted identity protocol."
      );
    }
    return false;
  }
  return true;
}

export const RUNTIME_HOSTING_STORAGE_STATEMENTS: readonly string[] = [
  `ALTER TABLE deployment_runtime_identity
   ADD COLUMN IF NOT EXISTS hosting_authority text NOT NULL DEFAULT 'independent'
   CHECK (hosting_authority IN ('independent', 'tulipfarm'))`,
];

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
  hosting_authority: RuntimeDeploymentContext["hostingAuthority"];
}

/** Initialize after API migrations, before serving requests or starting worker loops. */
export async function initializeRuntimeDeployment(
  database: Queryable,
  config: RuntimeDeploymentConfig,
  testTrust?: RuntimeDeploymentTestTrust
): Promise<RuntimeDeploymentContext> {
  const authority = hostingAuthority(config.hostingAuthority);
  if (!config.businessId.trim() || config.businessId.includes("\0")) {
    throw new RuntimeDeploymentConfigError("BUSINESS_ID must be non-empty text");
  }
  if (
    config.installationId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.installationId)
  ) {
    throw new RuntimeDeploymentConfigError("RUNTIME_INSTALLATION_ID must be a UUID when supplied");
  }
  if (authority === "tulipfarm") {
    if (!config.installationId) {
      throw new RuntimeDeploymentConfigError(
        "RUNTIME_INSTALLATION_ID is required for explicitly configured TulipFarm hosting."
      );
    }
    if (process.env.NODE_ENV !== "test" || typeof testTrust?.verifyIdentity !== "function") {
      throw new RuntimeDeploymentConfigError(
        "Hosted operation is unavailable: this release has no production hosted identity protocol. Tests must explicitly inject identity trust."
      );
    }
    try {
      await testTrust.verifyIdentity(
        Object.freeze({
          businessId: config.businessId,
          installationId: config.installationId.toLowerCase(),
        })
      );
    } catch {
      throw new RuntimeDeploymentTrustUnavailableError();
    }
  }

  await database.query(
    `INSERT INTO deployment_runtime_identity (singleton, installation_id, business_id, hosting_authority)
     VALUES (true, COALESCE($1::uuid, gen_random_uuid()), $2, $3)
     ON CONFLICT (singleton) DO NOTHING`,
    [config.installationId ?? null, config.businessId, authority]
  );
  // A separate statement sees a concurrent winner after ON CONFLICT waits for its commit.
  const result = await database.query<RuntimeIdentityRow>(
    `SELECT installation_id, business_id, hosting_authority FROM deployment_runtime_identity WHERE singleton = true`
  );
  const identity = result.rows[0];
  if (!identity) throw new Error("Persisted runtime identity is unavailable");
  if (identity.hosting_authority !== authority) {
    throw new RuntimeIdentityMismatchError("RUNTIME_HOSTING_AUTHORITY");
  }
  if (identity.business_id !== config.businessId) {
    throw new RuntimeIdentityMismatchError("BUSINESS_ID");
  }
  if (
    config.installationId !== undefined &&
    identity.installation_id !== config.installationId.toLowerCase()
  ) {
    throw new RuntimeIdentityMismatchError("RUNTIME_INSTALLATION_ID");
  }
  const context = Object.freeze({
    hostingAuthority: identity.hosting_authority,
    businessId: identity.business_id,
    installationId: identity.installation_id,
  });
  validatedContexts.add(context);
  return context;
}
