import { describe, expect, it } from "vitest";
import { resolveSoulPath } from "./soul-path";

describe("resolveSoulPath", () => {
  it("joins root, businessId, and soul", () => {
    expect(resolveSoulPath("/data/souls", "biz-1")).toBe("/data/souls/biz-1/soul");
  });
});
