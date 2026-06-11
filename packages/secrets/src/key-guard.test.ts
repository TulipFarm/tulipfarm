import { describe, expect, it } from "vitest";

import { assertValidSecretKey, InvalidSecretKeyError } from "./key-guard";

describe("assertValidSecretKey", () => {
  it("accepts valid keys", () => {
    expect(() => assertValidSecretKey("OPENAI_API_KEY")).not.toThrow();
    expect(() => assertValidSecretKey("oauth.token")).not.toThrow();
    expect(() => assertValidSecretKey("a-b_c.1")).not.toThrow();
  });

  it("rejects dangerous keys", () => {
    expect(() => assertValidSecretKey("__proto__")).toThrow(InvalidSecretKeyError);
    expect(() => assertValidSecretKey("prototype")).toThrow(InvalidSecretKeyError);
    expect(() => assertValidSecretKey("constructor")).toThrow(InvalidSecretKeyError);
  });

  it("rejects empty string", () => {
    expect(() => assertValidSecretKey("")).toThrow(InvalidSecretKeyError);
  });

  it("rejects keys longer than 256 chars", () => {
    expect(() => assertValidSecretKey("a".repeat(257))).toThrow(InvalidSecretKeyError);
  });

  it("rejects keys with spaces", () => {
    expect(() => assertValidSecretKey("my key")).toThrow(InvalidSecretKeyError);
  });

  it("rejects keys with unicode", () => {
    expect(() => assertValidSecretKey("clé")).toThrow(InvalidSecretKeyError);
  });
});
