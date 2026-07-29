import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CanonicalizationError } from "./errors";

export const CANONICAL_HASH_ALGORITHM = "sha256" as const;

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPath(path: string, segment: string): string {
  return `${path}/${pointerSegment(segment)}`;
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalizationError(path);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new CanonicalizationError(path);
  if (ancestors.has(value)) throw new CanonicalizationError(path);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const indexPath = childPath(path, String(index));
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new CanonicalizationError(indexPath);
        }
        items.push(serialize(descriptor.value, indexPath, ancestors));
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key === "symbol") throw new CanonicalizationError(path);
        const index = Number(key);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= value.length ||
          String(index) !== key
        ) {
          throw new CanonicalizationError(childPath(path, key));
        }
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError(path);
    }

    const entries: string[] = [];
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) throw new CanonicalizationError(path);
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new CanonicalizationError(childPath(path, key));
      }
      entries.push(
        `${JSON.stringify(key)}:${serialize(descriptor.value, childPath(path, key), ancestors)}`
      );
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Canonical JSON for parsed data. Object keys sort by UTF-16 code unit; arrays retain order. */
export function canonicalize(value: unknown): string {
  return serialize(value, "", new Set());
}

/** Lowercase SHA-256 hex over the UTF-8 bytes of {@link canonicalize}. */
export function canonicalHash(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalize(value))));
}
