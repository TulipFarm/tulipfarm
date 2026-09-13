import { createHmac } from "node:crypto";
import type { OimContinuationState, OimPaginationRuntime } from "@tulipfarm/integrations";
import {
  type ActiveDek,
  decryptSecret,
  encryptSecret,
  type SecretEnvelope,
} from "@tulipfarm/secrets";

const KEY_DOMAIN = "tulipfarm.oim.continuation.v1";
const TOKEN_PREFIX = "oim1.";
const DEFAULT_MAX_AGE_MS = 60_000;
const MAX_TOKEN_LENGTH = 4_096;

export interface OimPaginationRuntimeOptions {
  readonly dek: Pick<ActiveDek, "key">;
  readonly now?: () => number;
  readonly maxAgeMs?: number;
}

function deriveKey(key: Buffer): Buffer {
  return createHmac("sha256", key).update(KEY_DOMAIN).digest();
}

function encodeEnvelope(envelope: SecretEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function decodeEnvelope(token: string): SecretEnvelope {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("invalid continuation envelope");
  const bytes = Buffer.from(token, "base64url");
  if (bytes.toString("base64url") !== token) throw new Error("invalid continuation envelope");
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid continuation envelope");
  }
  const { encryptedValue, iv, authTag } = parsed as Record<string, unknown>;
  if (typeof encryptedValue !== "string" || typeof iv !== "string" || typeof authTag !== "string") {
    throw new Error("invalid continuation envelope");
  }
  return { encryptedValue, iv, authTag };
}

export function createOimPaginationRuntime(
  options: OimPaginationRuntimeOptions
): OimPaginationRuntime {
  const key = deriveKey(options.dek.key);
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error("invalid continuation token lifetime");
  }
  return {
    now,
    codec: {
      async seal(state: OimContinuationState): Promise<string> {
        const envelope = encryptSecret(JSON.stringify(state), key);
        const token = `${TOKEN_PREFIX}${encodeEnvelope(envelope)}`;
        if (token.length > MAX_TOKEN_LENGTH) {
          throw new Error("continuation token is too large");
        }
        return token;
      },
      async unseal(
        token: string,
        expected: Pick<OimContinuationState, "toolId" | "scope" | "style">
      ): Promise<unknown> {
        if (token.length > MAX_TOKEN_LENGTH || !token.startsWith(TOKEN_PREFIX)) {
          throw new Error("invalid continuation token");
        }
        const envelope = decodeEnvelope(token.slice(TOKEN_PREFIX.length));
        const state: unknown = JSON.parse(decryptSecret(envelope, { current: key }));
        if (state === null || typeof state !== "object" || Array.isArray(state)) {
          throw new Error("invalid continuation token");
        }
        const candidate = state as Record<string, unknown>;
        const progress = candidate.progress as Record<string, unknown> | undefined;
        const startedAtMs = progress?.startedAtMs;
        const observedAt = now();
        if (
          candidate.toolId !== expected.toolId ||
          candidate.scope !== expected.scope ||
          candidate.style !== expected.style ||
          !Number.isSafeInteger(startedAtMs) ||
          !Number.isSafeInteger(observedAt) ||
          Number(startedAtMs) > observedAt ||
          observedAt - Number(startedAtMs) >= maxAgeMs
        ) {
          throw new Error("invalid continuation token");
        }
        return state;
      },
    },
  };
}
