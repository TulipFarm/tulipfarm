import { describe, expect, it } from "vitest";
import { ajv } from "./ajv";
import { INVOCATION_REQUEST_SCHEMAS } from "./invocation";

describe("invocation request registry", () => {
  it("registers unique refs and compiles every schema", () => {
    const refs = INVOCATION_REQUEST_SCHEMAS.map((entry) => entry.ref);
    expect(new Set(refs).size).toBe(refs.length);
    for (const entry of INVOCATION_REQUEST_SCHEMAS) {
      expect(() => ajv.compile(entry.schema)).not.toThrow();
    }
  });
});
