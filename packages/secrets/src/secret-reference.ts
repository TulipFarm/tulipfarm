import { assertValidSecretKey } from "./key-guard";

const SECRET_REFERENCE_PATTERN =
  /^secret:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/** Maps an opaque Secret reference to its storage key without deriving authority from it. */
export function secretStorageKey(secretRef: string): string {
  const match = SECRET_REFERENCE_PATTERN.exec(secretRef);
  if (match?.[1] === undefined) {
    throw new Error("Secret bindings must use an opaque secret:// UUID reference");
  }
  assertValidSecretKey(match[1]);
  return match[1];
}
