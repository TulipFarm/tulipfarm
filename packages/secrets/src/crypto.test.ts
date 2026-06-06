import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DecryptError, decryptSecret, encryptSecret } from "./crypto";

describe("crypto", () => {
  it("round-trips encrypt then decrypt with current key", () => {
    const key = randomBytes(32);
    const plaintext = "super-secret-value";

    const envelope = encryptSecret(plaintext, key);

    expect(decryptSecret(envelope, { current: key })).toBe(plaintext);
  });

  it("produces a 12-byte iv and 16-byte authTag", () => {
    const key = randomBytes(32);

    const env = encryptSecret("hello", key);

    expect(Buffer.from(env.iv, "base64").length).toBe(12);
    expect(Buffer.from(env.authTag, "base64").length).toBe(16);
  });

  it("uses a fresh iv per call for the same plaintext and key", () => {
    const key = randomBytes(32);

    const a = encryptSecret("same", key);
    const b = encryptSecret("same", key);

    expect(a.iv).not.toBe(b.iv);
  });

  it("throws DecryptError on a tampered authTag", () => {
    const key = randomBytes(32);
    const env = encryptSecret("payload", key);

    const tampered = { ...env, authTag: randomBytes(16).toString("base64") };

    expect(() => decryptSecret(tampered, { current: key })).toThrow(DecryptError);
  });

  it("throws DecryptError on tampered ciphertext", () => {
    const key = randomBytes(32);
    const env = encryptSecret("payload", key);

    const bytes = Buffer.from(env.encryptedValue, "base64");
    bytes[0] = bytes[0] ^ 0xff;
    const tampered = { ...env, encryptedValue: bytes.toString("base64") };

    expect(() => decryptSecret(tampered, { current: key })).toThrow(DecryptError);
  });

  it("decrypts with the previous key after rotation", () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);

    const env = encryptSecret("rotate-me", oldKey);

    expect(decryptSecret(env, { current: newKey, previous: oldKey })).toBe("rotate-me");
  });

  it("throws DecryptError when both keys are wrong", () => {
    const key = randomBytes(32);
    const env = encryptSecret("payload", key);

    const keys = { current: randomBytes(32), previous: randomBytes(32) };

    expect(() => decryptSecret(env, keys)).toThrow(DecryptError);
  });

  it("throws DecryptError on a malformed iv (wrong length)", () => {
    const key = randomBytes(32);
    const env = encryptSecret("payload", key);

    const malformed = { ...env, iv: randomBytes(8).toString("base64") };

    expect(() => decryptSecret(malformed, { current: key })).toThrow(/malformed envelope: iv/);
  });

  it("throws DecryptError on a malformed authTag (wrong length)", () => {
    const key = randomBytes(32);
    const env = encryptSecret("payload", key);

    const malformed = { ...env, authTag: randomBytes(8).toString("base64") };

    expect(() => decryptSecret(malformed, { current: key })).toThrow(/malformed envelope: authTag/);
  });
});
