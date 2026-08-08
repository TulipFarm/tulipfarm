// Startup environment validation. Pure functions only — importing this module
// must not boot the app (so unit tests can exercise these without side effects).

export function validateBase64Secret(
  name: string,
  env: Record<string, string | undefined>,
  exit: (code: number) => void
): void {
  try {
    const buf = Buffer.from(env[name] as string, "base64");
    if (buf.length !== 32) {
      console.error(`❌ ${name} must be 32 bytes base64 (got ${buf.length} bytes)`);
      console.error("   Generate with: openssl rand -base64 32");
      exit(1);
    }
  } catch {
    console.error(`❌ ${name} is not valid base64`);
    exit(1);
  }
}

export function validateUriPrefix(
  name: string,
  prefixes: string[],
  env: Record<string, string | undefined>,
  exit: (code: number) => void
): void {
  const value = env[name] as string;
  if (!prefixes.some((p) => value.startsWith(p))) {
    console.error(`❌ ${name} must start with ${prefixes.join(" or ")}`);
    exit(1);
  }
}

export function validateEnvironment(
  env: Record<string, string | undefined> = process.env,
  exit: (code: number) => void = process.exit
): void {
  const required = ["DATABASE_URL", "ENCRYPTION_KEY", "JWT_SECRET", "WEBHOOK_SIGNING_SECRET"];
  const missing = required.filter((key) => !env[key]);

  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);
    console.error("📋 Copy .env.local.example to .env.local and generate secrets:");
    console.error("   openssl rand -base64 32");
    exit(1);
  }

  // Exactly one of SOUL_PATH (legacy single-tenant checkout, still how local dev works) or
  // SOUL_ROOT (per-business checkouts at <root>/<businessId>/soul, see resolveSoulPath) must be
  // set — the boot sequence needs a soul-location strategy either way.
  if (!env.SOUL_PATH && !env.SOUL_ROOT) {
    console.error("❌ Missing required environment variable: SOUL_PATH or SOUL_ROOT");
    console.error("📋 Copy .env.local.example to .env.local and generate secrets:");
    console.error("   openssl rand -base64 32");
    exit(1);
  }
  if (env.SOUL_PATH && env.SOUL_ROOT) {
    console.error("❌ SOUL_PATH and SOUL_ROOT are mutually exclusive — set only one");
    exit(1);
  }

  // Validate all secrets are 32 bytes base64
  for (const name of ["ENCRYPTION_KEY", "JWT_SECRET", "WEBHOOK_SIGNING_SECRET"]) {
    validateBase64Secret(name, env, exit);
  }

  // Validate URI prefixes
  validateUriPrefix("DATABASE_URL", ["postgres://", "postgresql://"], env, exit);

  // Validate ENCRYPTION_KEY_PREVIOUS if set (optional, used for key rotation)
  if (env.ENCRYPTION_KEY_PREVIOUS !== undefined) {
    validateBase64Secret("ENCRYPTION_KEY_PREVIOUS", env, exit);
  }

  // Validate API_TOKEN_PEPPER if set (optional). When present, API-token hashes use
  // HMAC-SHA256(token, pepper) instead of bare SHA-256; absence keeps legacy SHA-256 hashing.
  // Not required — pepper loss is acceptable (tokens are re-issuable).
  if (env.API_TOKEN_PEPPER !== undefined) {
    validateBase64Secret("API_TOKEN_PEPPER", env, exit);
  }

  // Validate SESSION_TTL_SECONDS if set (optional)
  if (env.SESSION_TTL_SECONDS !== undefined) {
    const ttl = Number.parseInt(env.SESSION_TTL_SECONDS, 10);
    if (Number.isNaN(ttl) || ttl <= 0) {
      console.error("❌ SESSION_TTL_SECONDS must be a positive integer");
      exit(1);
    }
  }
}

export function logEnvironmentStatus(logger: { info: (msg: string) => void }): void {
  const vars = ["DATABASE_URL", "ENCRYPTION_KEY", "JWT_SECRET", "WEBHOOK_SIGNING_SECRET"];
  const status = vars.map((name) => `${name}: ✓ set`).join(", ");
  const soulVar = process.env.SOUL_PATH ? "SOUL_PATH" : "SOUL_ROOT";
  logger.info(`Environment validated — ${status}, ${soulVar}: ✓ set`);
}
