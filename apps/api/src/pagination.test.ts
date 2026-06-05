import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, parsePaginationQuery } from "./pagination";

const DOC = { createdAt: new Date("2024-01-15T10:00:00.000Z"), _id: "abc123" };

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a valid cursor", () => {
    const encoded = encodeCursor(DOC);
    const decoded = decodeCursor(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.createdAt.toISOString()).toBe(DOC.createdAt.toISOString());
    expect(decoded?._id).toBe(DOC._id);
  });

  it("encoded value is base64 (no JSON visible)", () => {
    const encoded = encodeCursor(DOC);
    expect(encoded).not.toContain("{");
    expect(encoded).not.toContain("createdAt");
  });

  it("returns null for empty string", () => {
    expect(decodeCursor("")).toBeNull();
  });

  it("returns null for non-base64 garbage", () => {
    expect(decodeCursor("not-valid!!")).toBeNull();
  });

  it("returns null for base64 of non-cursor JSON", () => {
    const bad = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null for base64 with invalid date", () => {
    const bad = Buffer.from(JSON.stringify({ createdAt: "not-a-date", _id: "x" })).toString(
      "base64"
    );
    expect(decodeCursor(bad)).toBeNull();
  });
});

describe("parsePaginationQuery", () => {
  it("defaults limit to 20", () => {
    expect(parsePaginationQuery({}).limit).toBe(20);
  });

  it("parses a valid limit", () => {
    expect(parsePaginationQuery({ limit: "50" }).limit).toBe(50);
  });

  it("clamps limit min to 1", () => {
    expect(parsePaginationQuery({ limit: "0" }).limit).toBe(1);
    expect(parsePaginationQuery({ limit: "-5" }).limit).toBe(1);
  });

  it("clamps limit max to 100", () => {
    expect(parsePaginationQuery({ limit: "999" }).limit).toBe(100);
  });

  it("defaults to 20 for non-numeric limit", () => {
    expect(parsePaginationQuery({ limit: "abc" }).limit).toBe(20);
  });

  it("returns no after when cursor absent", () => {
    expect(parsePaginationQuery({ limit: "10" }).after).toBeUndefined();
  });

  it("parses a valid cursor into after", () => {
    const cursor = encodeCursor(DOC);
    const result = parsePaginationQuery({ cursor });
    expect(result.after).toBeDefined();
    expect(result.after?._id).toBe(DOC._id);
  });

  it("ignores malformed cursor (no after)", () => {
    const result = parsePaginationQuery({ cursor: "garbage!!" });
    expect(result.after).toBeUndefined();
  });

  it("ignores empty cursor string", () => {
    const result = parsePaginationQuery({ cursor: "" });
    expect(result.after).toBeUndefined();
  });
});
