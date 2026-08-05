import { describe, expect, it } from "vitest";
import { THINKING_STATUS } from "./thinking-status";

describe("THINKING_STATUS", () => {
  it("is a non-empty status string", () => {
    expect(THINKING_STATUS.length).toBeGreaterThan(0);
  });
});
