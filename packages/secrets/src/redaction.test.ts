import { describe, expect, it } from "vitest";
import { containsSecret, REDACTED, redactError, redactSecrets } from "./redaction";

describe("redactSecrets", () => {
  it("replaces every occurrence of every secret", () => {
    const text = "curl -H 'Authorization: Bearer tok-abc' https://x/tok-abc?k=pw-1";
    expect(redactSecrets(text, ["tok-abc", "pw-1"])).toBe(
      `curl -H 'Authorization: Bearer ${REDACTED}' https://x/${REDACTED}?k=${REDACTED}`
    );
  });

  it("ignores empty secrets so the whole text is not shredded", () => {
    expect(redactSecrets("hello", [""])).toBe("hello");
  });
});

describe("containsSecret", () => {
  it("finds a secret nested in objects, arrays, and keys", () => {
    expect(containsSecret({ a: [{ b: "prefix tok-abc suffix" }] }, ["tok-abc"])).toBe(true);
    expect(containsSecret({ "tok-abc": 1 }, ["tok-abc"])).toBe(true);
    expect(containsSecret({ a: "clean" }, ["tok-abc"])).toBe(false);
  });

  it("treats a non-string scalar as clean", () => {
    expect(containsSecret(42, ["42"])).toBe(false);
  });
});

describe("redactError", () => {
  it("redacts message and stack without changing the error type", () => {
    class Boom extends Error {}
    const original = new Boom("failed with tok-abc");
    const redacted = redactError(original, ["tok-abc"]);
    expect(redacted).toBeInstanceOf(Boom);
    expect(redacted.message).toBe(`failed with ${REDACTED}`);
    expect(redacted.stack ?? "").not.toContain("tok-abc");
  });

  it("wraps a non-Error throw into a redacted Error", () => {
    const redacted = redactError("raw tok-abc", ["tok-abc"]);
    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.message).toBe(`raw ${REDACTED}`);
  });
});
