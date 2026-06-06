import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { EncryptionKeyError, loadEncryptionKeys } from "./keys";

describe("loadEncryptionKeys", () => {
  it("loads a valid 32-byte base64 ENCRYPTION_KEY", () => {
    const key = randomBytes(32).toString("base64");

    const keys = loadEncryptionKeys({ ENCRYPTION_KEY: key });

    expect(Buffer.isBuffer(keys.current)).toBe(true);
    expect(keys.current).toHaveLength(32);
    expect(keys.previous).toBeUndefined();
  });

  it("throws EncryptionKeyError when ENCRYPTION_KEY is missing", () => {
    expect(() => loadEncryptionKeys({})).toThrow(EncryptionKeyError);
  });

  it("throws EncryptionKeyError when ENCRYPTION_KEY is the wrong length", () => {
    const shortKey = randomBytes(16).toString("base64");

    expect(() => loadEncryptionKeys({ ENCRYPTION_KEY: shortKey })).toThrow(EncryptionKeyError);
  });

  it("loads a valid ENCRYPTION_KEY_PREVIOUS into previous", () => {
    const current = randomBytes(32).toString("base64");
    const previous = randomBytes(32).toString("base64");

    const keys = loadEncryptionKeys({
      ENCRYPTION_KEY: current,
      ENCRYPTION_KEY_PREVIOUS: previous,
    });

    expect(keys.previous).toBeDefined();
    expect(keys.previous).toHaveLength(32);
  });

  it("throws EncryptionKeyError when ENCRYPTION_KEY_PREVIOUS is malformed", () => {
    const current = randomBytes(32).toString("base64");
    const previous = randomBytes(16).toString("base64");

    expect(() =>
      loadEncryptionKeys({
        ENCRYPTION_KEY: current,
        ENCRYPTION_KEY_PREVIOUS: previous,
      })
    ).toThrow(EncryptionKeyError);
  });
});
