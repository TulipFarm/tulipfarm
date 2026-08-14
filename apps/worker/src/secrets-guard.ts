import { SecretsService } from "@tulipfarm/secrets";

// Namespace both bundle-signing Secrets share (`soul-bundle.ed25519.{private,public}-key`). Kept as
// a local literal because the worker must not deepen its narrow `soul` edge for a naming constant.
const SOUL_BUNDLE_PREFIX = "soul-bundle.";

/** Refusal for bundle-signing secrets the Worker must never hold; carries key name only. */
export class WorkerSecretForbiddenError extends Error {
  constructor(readonly key: string) {
    super(`worker is not permitted to read secret "${key}"`);
    this.name = "WorkerSecretForbiddenError";
  }
}

/** Denies all `soul-bundle.*` secrets except the public verification key. */
export function isWorkerForbiddenSecret(key: string): boolean {
  return key.startsWith(SOUL_BUNDLE_PREFIX) && !key.endsWith(".public-key");
}

/** Refuses forbidden bundle secrets before touching the store. */
export class GuardedWorkerSecretsService extends SecretsService {
  async get(key: string): Promise<string> {
    if (isWorkerForbiddenSecret(key)) {
      throw new WorkerSecretForbiddenError(key);
    }
    return super.get(key);
  }
}
