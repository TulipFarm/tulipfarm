import { describe, expect, it } from "vitest";
import {
  FailureInjector,
  FakeClock,
  FakeIntegrationAdapter,
  FakeModelAdapter,
  FakeToolAdapter,
  MonotonicIdSource,
  withTestSchema,
  withTestTransaction,
} from "./index";

describe("@tulipfarm/testkit public surface", () => {
  it("exports every reusable helper from one package entry point", () => {
    expect([
      FakeClock,
      FailureInjector,
      FakeIntegrationAdapter,
      FakeModelAdapter,
      FakeToolAdapter,
      MonotonicIdSource,
      withTestSchema,
      withTestTransaction,
    ]).not.toContain(undefined);
  });
});
