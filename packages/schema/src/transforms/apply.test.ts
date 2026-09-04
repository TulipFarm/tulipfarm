import { describe, expect, it } from "vitest";
import { TulipFarmValidationError } from "../error";
import { applyTransforms } from "./apply";
import { validateResourceSchema } from "./validate-schema";

const makeCounter = (start = 1) => {
  let n = start - 1;
  return async (_type: string) => ++n;
};

describe("applyTransforms", () => {
  describe("x-id-strategy", () => {
    it("assigns prefix+sequence to id field", async () => {
      const schema = {
        type: "object",
        "x-id-strategy": { prefix: "TICK-", sequence: true },
        properties: { id: { type: "string" } },
      };
      const result = await applyTransforms("ticket", schema, {}, { counter: makeCounter() });
      expect(result.id).toBe("TICK-1");
    });

    it("increments counter sequentially", async () => {
      const schema = {
        type: "object",
        "x-id-strategy": { prefix: "TICK-", sequence: true },
        properties: { id: { type: "string" } },
      };
      const counter = makeCounter();
      const r1 = await applyTransforms("ticket", schema, {}, { counter });
      const r2 = await applyTransforms("ticket", schema, {}, { counter });
      expect(r1.id).toBe("TICK-1");
      expect(r2.id).toBe("TICK-2");
    });

    it("uses custom field name", async () => {
      const schema = {
        type: "object",
        "x-id-strategy": { field: "ref", prefix: "REF-", sequence: true },
        properties: { ref: { type: "string" } },
      };
      const result = await applyTransforms("item", schema, {}, { counter: makeCounter() });
      expect(result.ref).toBe("REF-1");
    });

    it("throws TulipFarmValidationError if counter missing", async () => {
      const schema = {
        "x-id-strategy": { prefix: "TICK-", sequence: true },
        properties: {},
      };
      await expect(applyTransforms("ticket", schema, {})).rejects.toBeInstanceOf(
        TulipFarmValidationError
      );
    });
  });

  describe("x-normalize", () => {
    it("phone-e164: (415) 555-0100 → +14155550100", async () => {
      const schema = {
        type: "object",
        properties: { phone: { type: "string", "x-normalize": ["phone-e164"] } },
      };
      const result = await applyTransforms("contact", schema, { phone: "(415) 555-0100" });
      expect(result.phone).toBe("+14155550100");
    });

    it("trim + lowercase applied in order", async () => {
      const schema = {
        type: "object",
        properties: { title: { type: "string", "x-normalize": ["trim", "lowercase"] } },
      };
      const result = await applyTransforms("item", schema, { title: "  Hello World  " });
      expect(result.title).toBe("hello world");
    });

    it("skips non-string fields", async () => {
      const schema = {
        type: "object",
        properties: { count: { type: "number", "x-normalize": ["trim"] } },
      };
      const result = await applyTransforms("item", schema, { count: 42 });
      expect(result.count).toBe(42);
    });
  });

  describe("x-computed", () => {
    it("sha256 of concatenated fields", async () => {
      const schema = {
        type: "object",
        "x-computed": { field: "digest", from: ["title", "body"], fn: "sha256" },
        properties: { title: {}, body: {}, digest: {} },
      };
      const result = await applyTransforms("doc", schema, { title: "hello", body: "world" });
      expect(typeof result.digest).toBe("string");
      expect((result.digest as string).length).toBe(64);
    });

    it("uuid generates a UUID string", async () => {
      const schema = {
        type: "object",
        "x-computed": { field: "uid", from: [], fn: "uuid" },
        properties: { uid: {} },
      };
      const result = await applyTransforms("doc", schema, {});
      expect(typeof result.uid).toBe("string");
      expect(result.uid as string).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it("array of x-computed specs", async () => {
      const schema = {
        type: "object",
        "x-computed": [
          { field: "digest", from: ["title"], fn: "sha256" },
          { field: "uid", from: [], fn: "uuid" },
        ],
        properties: { title: {}, digest: {}, uid: {} },
      };
      const result = await applyTransforms("doc", schema, { title: "test" });
      expect(typeof result.digest).toBe("string");
      expect(typeof result.uid).toBe("string");
    });
  });

  describe("pipeline order", () => {
    it("id-strategy → normalize → computed", async () => {
      const counter = makeCounter();
      const schema = {
        type: "object",
        "x-id-strategy": { prefix: "ID-", sequence: true },
        "x-computed": { field: "slug", from: ["id", "title"], fn: "sha256" },
        properties: {
          id: { type: "string" },
          title: { type: "string", "x-normalize": ["trim"] },
          slug: { type: "string" },
        },
      };
      const result = await applyTransforms("item", schema, { title: "  Hello  " }, { counter });
      expect(result.id).toBe("ID-1");
      expect(result.title).toBe("Hello");
      expect(typeof result.slug).toBe("string");
    });
  });
});

describe("validateResourceSchema", () => {
  it("passes for valid schema", () => {
    expect(() =>
      validateResourceSchema({
        type: "object",
        "x-id-strategy": { prefix: "TICK-", sequence: true },
        "x-computed": { field: "digest", from: ["title"], fn: "sha256" },
        properties: {
          title: { type: "string", "x-normalize": ["trim", "lowercase"] },
          phone: { type: "string", "x-normalize": ["phone-e164"] },
        },
      })
    ).not.toThrow();
  });

  it("rejects unknown x-normalize entry (AC: rejected at schema load)", () => {
    expect(() =>
      validateResourceSchema({
        properties: { phone: { "x-normalize": ["unknown-normalizer"] } },
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("rejects unknown x-computed.fn (AC: rejected at schema load)", () => {
    expect(() =>
      validateResourceSchema({
        "x-computed": { field: "f", from: [], fn: "bad-fn" },
        properties: {},
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("accepts x-unique naming declared fields, single and combined", () => {
    expect(() =>
      validateResourceSchema({
        "x-unique": [["email"], ["firstName", "lastName"]],
        properties: {
          email: { type: "string" },
          firstName: { type: "string" },
          lastName: { type: "string" },
        },
      })
    ).not.toThrow();
  });

  it("rejects x-unique naming an undeclared field", () => {
    expect(() =>
      validateResourceSchema({
        "x-unique": [["ghost"]],
        properties: { email: { type: "string" } },
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("rejects an empty x-unique entry", () => {
    expect(() =>
      validateResourceSchema({
        "x-unique": [[]],
        properties: {},
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("rejects x-unique that is not an array", () => {
    expect(() =>
      validateResourceSchema({
        "x-unique": "email",
        properties: { email: { type: "string" } },
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("error carries boundary=resource", () => {
    try {
      validateResourceSchema({
        properties: { x: { "x-normalize": ["bad"] } },
      });
    } catch (err) {
      expect((err as TulipFarmValidationError).boundary).toBe("resource");
    }
  });
});
