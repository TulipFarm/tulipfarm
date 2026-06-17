import { Buffer } from "node:buffer";
import { KV_NAME_RE, MAX_KEY_CHARS, MAX_NAMESPACE_CHARS, MAX_VALUE_BYTES } from "./limits";
import type { KvEntry, KvRepo, KvScope } from "./repo";

export type SetOutcome =
  | { kind: "ok" }
  | { kind: "rejected_oversize"; bytes: number }
  | { kind: "rejected_invalid"; reason: string };

/**
 * Owns the KV write policy (KV-V1): namespace/key charset+length validation, the value BYTE cap, and
 * TTL handling. The repo stays dumb CRUD so this is testable against an in-memory fake. The tool and
 * route layers pin `scope`+`ownerId` from caller identity before calling in; internal backend callers
 * may address any scope directly. `created_at` preservation is handled by the repo's upsert (it omits
 * created_at from the conflict update), so no read-before-write is needed.
 */
export class KvService {
  constructor(private readonly repo: KvRepo) {}

  async set(
    scope: KvScope,
    ownerId: string | undefined,
    namespace: string,
    key: string,
    value: unknown,
    expiresAt?: Date
  ): Promise<SetOutcome> {
    const invalid =
      validateName("namespace", namespace, MAX_NAMESPACE_CHARS) ??
      validateName("key", key, MAX_KEY_CHARS);
    if (invalid) return { kind: "rejected_invalid", reason: invalid };
    // JSON null is a valid storable value; only a genuinely missing value (undefined) is rejected.
    if (value === undefined) return { kind: "rejected_invalid", reason: "value is required" };

    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > MAX_VALUE_BYTES) return { kind: "rejected_oversize", bytes };

    const now = new Date();
    await this.repo.upsert({
      scope,
      ownerId,
      namespace,
      key,
      value,
      expiresAt,
      createdAt: now, // used only on INSERT; preserved on conflict by the repo
      updatedAt: now,
    });
    return { kind: "ok" };
  }

  get(
    scope: KvScope,
    ownerId: string | undefined,
    namespace: string,
    key: string
  ): Promise<KvEntry | null> {
    return this.repo.get(scope, ownerId, namespace, key);
  }

  delete(
    scope: KvScope,
    ownerId: string | undefined,
    namespace: string,
    key: string
  ): Promise<boolean> {
    return this.repo.delete(scope, ownerId, namespace, key);
  }

  list(scope: KvScope, ownerId: string | undefined, namespace: string): Promise<KvEntry[]> {
    return this.repo.listByNamespace(scope, ownerId, namespace);
  }
}

function validateName(label: string, value: string, max: number): string | null {
  if (!value) return `${label} must be non-empty`;
  if (value.length > max) return `${label} exceeds ${max} characters`;
  if (!KV_NAME_RE.test(value)) return `${label} has invalid characters`;
  return null;
}
