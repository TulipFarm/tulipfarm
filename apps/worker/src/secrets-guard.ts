import { SecretsService } from "@tulipfarm/secrets";

// Namespace both bundle-signing Secrets share (`soul-bundle.ed25519.{private,public}-key`). Kept as
// a local literal because the worker must not deepen its narrow `soul` edge for a naming constant.
const SOUL_BUNDLE_PREFIX = "soul-bundle.";

/**
 * Refusal raised when the worker asks for a secret the asymmetric bundle-store split forbids it
 * from ever holding. Carries the key name (safe to log) — never the value.
 */
export class WorkerSecretForbiddenError extends Error {
  constructor(readonly key: string) {
    super(`worker is not permitted to read secret "${key}"`);
    this.name = "WorkerSecretForbiddenError";
  }
}

/**
 * Enforces the bundle-store trust split below the type system. The API signs execution bundles with
 * the Ed25519 private key; the worker only verifies, so it must never hold signing material — yet
 * the memoized `SecretsService` it is handed carries the DEK and can decrypt any row, making the
 * TypeScript narrowing on `WorkerSecretReader` a compile-time promise the runtime does not keep.
 *
 * Within the bundle-signing namespace the worker legitimately needs exactly one key, the public
 * verification key, so this denies every other `soul-bundle.*` key by default. Default-deny scoped
 * to that namespace covers a future signing-key name without re-enumerating it, and — unlike a
 * broad "anything private-key-shaped" rule — leaves Integration credentials the worker really reads
 * (e.g. `integration.github.GITHUB_APP_PRIVATE_KEY`) and Soul-authored LLM `api_key_ref`s alone.
 */
export function isWorkerForbiddenSecret(key: string): boolean {
  return key.startsWith(SOUL_BUNDLE_PREFIX) && !key.endsWith(".public-key");
}

/**
 * The `SecretsService` the worker composition injects. Behaves identically to the base service for
 * every legitimate read; refuses signing-key-shaped bundle secrets before touching the store.
 */
export class GuardedWorkerSecretsService extends SecretsService {
  async get(key: string): Promise<string> {
    if (isWorkerForbiddenSecret(key)) {
      throw new WorkerSecretForbiddenError(key);
    }
    return super.get(key);
  }
}
