import { describe, expect, it } from "vitest";
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validatePassword,
  verifyPassword,
} from "./passwords";

describe("passwords", () => {
  it("hashes to an argon2id string distinct from the plaintext", async () => {
    const hashed = await hashPassword("s3cret-pw");
    expect(hashed).not.toBe("s3cret-pw");
    expect(hashed).toMatch(/^\$argon2id\$/);
  });

  it("verifies the correct password", async () => {
    const hashed = await hashPassword("s3cret-pw");
    expect(await verifyPassword(hashed, "s3cret-pw")).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hashed = await hashPassword("s3cret-pw");
    expect(await verifyPassword(hashed, "wrong-pw")).toBe(false);
  });

  it("returns false for a malformed hash instead of throwing", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });
});

describe("validatePassword", () => {
  it("accepts a password meeting min length", () => {
    expect(validatePassword("a".repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it("accepts a password at max length", () => {
    expect(validatePassword("a".repeat(MAX_PASSWORD_LENGTH))).toBeNull();
  });

  it("rejects a password shorter than min length", () => {
    const err = validatePassword("short");
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/at least/);
  });

  it("rejects a password longer than max length", () => {
    const err = validatePassword("a".repeat(MAX_PASSWORD_LENGTH + 1));
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/at most/);
  });

  it("rejects an empty password", () => {
    expect(validatePassword("")).not.toBeNull();
  });
});
