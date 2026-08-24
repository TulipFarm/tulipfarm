import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { BOUNDARIES } from "./boundaries";
import { TulipFarmValidationError } from "./error";
import { validate } from "./validate";

const UserSchema = Type.Object({
  name: Type.String(),
  age: Type.Number(),
});

describe("validate", () => {
  it("passes for valid data", () => {
    expect(() => validate("api", UserSchema, { name: "Alice", age: 30 })).not.toThrow();
  });

  it("throws TulipFarmValidationError on invalid data", () => {
    expect(() => validate("api", UserSchema, { name: "Alice", age: "not-a-number" })).toThrow(
      TulipFarmValidationError
    );
  });

  it("error carries boundary", () => {
    try {
      validate("llm", UserSchema, { name: 123 });
    } catch (err) {
      expect(err).toBeInstanceOf(TulipFarmValidationError);
      expect((err as TulipFarmValidationError).boundary).toBe("llm");
    }
  });

  it("error carries path", () => {
    try {
      validate("resource", UserSchema, { name: "ok", age: "bad" });
    } catch (err) {
      expect(err).toBeInstanceOf(TulipFarmValidationError);
      expect((err as TulipFarmValidationError).path).toBe("/age");
    }
  });

  it("error carries message", () => {
    try {
      validate("soul", UserSchema, {});
    } catch (err) {
      expect(err).toBeInstanceOf(TulipFarmValidationError);
      expect((err as TulipFarmValidationError).message).toBeTruthy();
    }
  });

  it("x-* keywords in schema do not throw", () => {
    const SchemaWithXKeywords = Type.Object({ id: Type.String() }, {
      "x-id-strategy": { prefix: "TICK-", sequence: true },
    } as object);
    expect(() => validate("resource", SchemaWithXKeywords, { id: "TICK-1" })).not.toThrow();
  });

  it("BOUNDARIES contains all 8 entries", () => {
    expect(BOUNDARIES).toHaveLength(8);
    expect(BOUNDARIES).toContain("soul");
    expect(BOUNDARIES).toContain("resource");
    expect(BOUNDARIES).toContain("api");
    expect(BOUNDARIES).toContain("agent");
    expect(BOUNDARIES).toContain("llm");
    expect(BOUNDARIES).toContain("event");
    expect(BOUNDARIES).toContain("integration");
    expect(BOUNDARIES).toContain("deployment");
  });
});
