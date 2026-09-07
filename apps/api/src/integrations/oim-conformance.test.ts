import { OIM_CONFORMANCE_CASES } from "@oim-standard/conformance";
import { describe, expect, it } from "vitest";
import { runTulipFarmOimConformance } from "./oim-conformance";

describe("TulipFarm OIM conformance", () => {
  it("earns the Core 1.2 claim through production compilers and hermetic transports", async () => {
    const report = await runTulipFarmOimConformance("test");

    expect(report.claim.profiles).toEqual({ core: "1.2" });
    expect(report.claim.passedCases).toEqual(OIM_CONFORMANCE_CASES.core);
    expect(report.results.every((result) => result.status === "passed")).toBe(true);
    expect(report.results.map((result) => result.vectorId)).toEqual(
      expect.arrayContaining([
        "core-http-native-request",
        "core-http-form-request",
        "core-http-multipart-request",
        "core-openapi-allowlisted-operation",
        "core-graphql-fixed-document",
      ])
    );
  });
});
