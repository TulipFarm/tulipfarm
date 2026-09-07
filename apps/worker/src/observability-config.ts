import type { OtlpTarget } from "@tulipfarm/observability";
import { assertValidSecretKey, InvalidSecretKeyError } from "@tulipfarm/secrets";
import type { RemoteObservabilityConfig } from "./internal/turn-host";

const ENV_REF = /^env:\/\/[A-Z_][A-Z0-9_]*$/;
const SECRET_REF_PREFIX = "secret://";

export interface WorkerOtlpResolution {
  readonly env: Readonly<Record<string, string | undefined>>;
  secret(key: string): Promise<string>;
}

function secretKey(ref: string): string | undefined {
  if (!ref.startsWith(SECRET_REF_PREFIX)) return undefined;
  const key = ref.slice(SECRET_REF_PREFIX.length);
  try {
    assertValidSecretKey(key);
    return key;
  } catch (error) {
    if (error instanceof InvalidSecretKeyError) return undefined;
    throw error;
  }
}

/** Resolves only explicit environment and Secret references; plaintext never reaches an exporter. */
export async function resolveWorkerOtlpTarget(
  config: RemoteObservabilityConfig | undefined,
  resolution: WorkerOtlpResolution
): Promise<OtlpTarget | undefined> {
  if (config?.enabled !== true || config.otlp === null) return undefined;

  const ref = config.otlp.token;
  let token: string | undefined;
  if (ENV_REF.test(ref)) {
    token = resolution.env[ref.slice("env://".length)];
  } else {
    const key = secretKey(ref);
    if (key === undefined) return undefined;
    token = await resolution.secret(key).catch(() => undefined);
  }
  if (token === undefined || token.length === 0) return undefined;

  return {
    endpoint: config.otlp.endpoint,
    instanceId: config.otlp.instanceId,
    token,
  };
}
