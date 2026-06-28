import { describe, expect, it } from "vitest";
import { formatTokens, formatUsd } from "./observability";

describe("formatUsd", () => {
  it("formats normal amounts to cents", () => {
    expect(formatUsd(42.18)).toBe("$42.18");
  });
  it("shows extra precision for sub-cent spend so it isn't $0.00", () => {
    expect(formatUsd(0.0004)).toBe("$0.0004");
  });
  it("formats zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("formatTokens", () => {
  it("compacts millions and thousands", () => {
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(4_500)).toBe("4.5k");
  });
  it("leaves small counts as-is", () => {
    expect(formatTokens(320)).toBe("320");
  });
});
