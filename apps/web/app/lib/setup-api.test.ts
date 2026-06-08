import { describe, expect, it } from "vitest";
import { readCookie } from "./setup-api";

describe("readCookie", () => {
  it("reads a value from a cookie string", () => {
    expect(readCookie("csrf_token", "a=1; csrf_token=abc123; b=2")).toBe("abc123");
  });
  it("returns empty string when absent", () => {
    expect(readCookie("missing", "a=1; b=2")).toBe("");
  });
  it("url-decodes the value", () => {
    expect(readCookie("x", "x=hello%20world")).toBe("hello world");
  });
  it("returns empty for an empty source", () => {
    expect(readCookie("x", "")).toBe("");
  });
});
