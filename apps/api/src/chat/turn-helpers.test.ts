import { describe, expect, it } from "vitest";
import { parseLastEventId } from "./turn-helpers";

describe("parseLastEventId", () => {
  it("prefers the SSE header cursor", () => {
    expect(parseLastEventId("12", 4)).toBe(12);
    expect(parseLastEventId(undefined, 4)).toBe(4);
  });

  it("reads from the start when neither cursor is usable", () => {
    expect(parseLastEventId("", undefined)).toBe(0);
    expect(parseLastEventId("not-a-number", undefined)).toBe(0);
    expect(parseLastEventId(undefined, -1)).toBe(0);
  });
});
