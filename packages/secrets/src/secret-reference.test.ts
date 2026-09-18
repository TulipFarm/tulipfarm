import { describe, expect, it } from "vitest";
import { secretStorageKey } from "./secret-reference";

describe("opaque Secret references", () => {
  it("maps an opaque reference to the same storage key", () => {
    expect(secretStorageKey("secret://00000000-0000-4000-8000-000000000001")).toBe(
      "00000000-0000-4000-8000-000000000001"
    );
  });

  it.each(["ENV_TOKEN", "secret://provider.token", "secret://", "secret://__proto__"])(
    "rejects a non-opaque reference: %s",
    (reference) => {
      expect(() => secretStorageKey(reference)).toThrow("opaque secret:// UUID reference");
    }
  );
});
