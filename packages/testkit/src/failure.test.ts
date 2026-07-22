import { describe, expect, it } from "vitest";
import { FailureInjector, InjectedFailure } from "./failure";

describe("FailureInjector", () => {
  it.each([
    "before",
    "after",
  ] as const)("crashes %s a declared durable boundary without exposing payloads", async (phase) => {
    const injector = new FailureInjector(["effect.persist"] as const);
    injector.failAt("effect.persist", phase);
    let operationCalls = 0;

    const operation = injector.runAround("effect.persist", async () => {
      operationCalls += 1;
      return { secret: "do-not-copy-to-error" };
    });

    await expect(operation).rejects.toMatchObject({
      name: "InjectedFailure",
      code: "TESTKIT_INJECTED_FAILURE",
      boundary: "effect.persist",
      phase,
      occurrence: 1,
    });
    await expect(operation).rejects.not.toThrow("do-not-copy-to-error");
    expect(operationCalls).toBe(phase === "before" ? 0 : 1);
  });

  it("can target a later occurrence for crash/retry tests", async () => {
    const injector = new FailureInjector(["outbox.commit"] as const);
    injector.failAt("outbox.commit", "after", 2);

    await expect(injector.runAround("outbox.commit", async () => "first")).resolves.toBe("first");
    await expect(injector.runAround("outbox.commit", async () => "second")).rejects.toBeInstanceOf(
      InjectedFailure
    );
    expect(injector.hitCount("outbox.commit", "before")).toBe(2);
    expect(injector.hitCount("outbox.commit", "after")).toBe(2);
    expect(() => injector.assertDrained()).not.toThrow();
  });

  it("rejects unreachable plans and reports future plans that were never consumed", () => {
    const injector = new FailureInjector(["state.persist"] as const);
    injector.before("state.persist");

    expect(() => injector.failAt("state.persist", "before", 1)).toThrow("already passed");

    injector.failAt("state.persist", "after", 2);
    expect(() => injector.assertDrained()).toThrow(
      "unconsumed failure plan: state.persist:after:2"
    );
  });

  it("rejects undeclared boundaries and invalid occurrences", () => {
    const injector = new FailureInjector(["state.persist"] as const);

    expect(() => injector.failAt("state.persist", "before", 0)).toThrow("positive integer");
    expect(() => (injector as FailureInjector<string>).failAt("unknown", "before")).toThrow(
      "undeclared durable boundary"
    );
  });
});
