import { describe, expect, it } from "vitest";
import { formatCost, formatTokens } from "./observability";

describe("formatCost", () => {
  it("formats normal amounts to cents", () => {
    expect(formatCost(42.18)).toBe("$42.18");
  });
  it("shows extra precision for sub-cent spend so it isn't $0.00", () => {
    expect(formatCost(0.0004)).toBe("$0.0004");
  });
  it("formats zero", () => {
    expect(formatCost(0)).toBe("$0.00");
  });
  it("formats a non-USD currency code", () => {
    expect(formatCost(42.18, "INR")).toBe("₹42.18");
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
