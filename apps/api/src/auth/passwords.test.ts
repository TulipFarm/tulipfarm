import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords";

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
