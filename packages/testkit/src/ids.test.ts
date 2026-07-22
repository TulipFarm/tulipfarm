import { describe, expect, it } from "vitest";
import { MonotonicIdSource } from "./ids";

describe("MonotonicIdSource", () => {
  it("produces stable, increasing identifiers from isolated instances", () => {
    const first = new MonotonicIdSource({ prefix: "run", start: 7, width: 4 });
    const second = new MonotonicIdSource({ prefix: "run", start: 7, width: 4 });

    expect([first.next(), first.next(), first.next()]).toEqual([
      "run-0007",
      "run-0008",
      "run-0009",
    ]);
    expect([second.next(), second.next(), second.next()]).toEqual([
      "run-0007",
      "run-0008",
      "run-0009",
    ]);
  });

  it("rejects ambiguous configuration and numeric overflow", () => {
    expect(() => new MonotonicIdSource({ prefix: "bad prefix" })).toThrow("prefix");
    expect(() => new MonotonicIdSource({ prefix: "run", start: -1 })).toThrow("start");
    expect(() => new MonotonicIdSource({ prefix: "run", width: 0 })).toThrow("width");

    const source = new MonotonicIdSource({
      prefix: "run",
      start: Number.MAX_SAFE_INTEGER,
      width: 16,
    });
    expect(source.next()).toBe("run-9007199254740991");
    expect(() => source.next()).toThrow("exhausted");
  });
});
