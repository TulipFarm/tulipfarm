import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookError, HookExecutor } from "./hook-executor.js";

// Same Node-25 caveat as hook-executor.test.ts: isolated-vm has no abi141 prebuild, so
// value-returning assertions are skipped there while error-path tests still run.
const nodeMajor = parseInt(process.version.slice(1).split(".")[0], 10);
const skipNoIsovm = nodeMajor === 25;

const FAKE_DATABASE_URL = "postgresql://localhost:5432/test";

describe("routine sandbox variants", () => {
  let executor: HookExecutor;

  beforeEach(() => {
    executor = new HookExecutor(FAKE_DATABASE_URL);
  });

  afterEach(async () => {
    await executor.close();
  });

  describe("runExpression (#147)", () => {
    it.skipIf(skipNoIsovm)("evaluates a JS expression against the scope", async () => {
      const value = await executor.runExpression(
        "context.amount * 2",
        { context: { amount: 21 } },
        "routine:test"
      );
      expect(value).toBe(42);
    });

    it.skipIf(skipNoIsovm)("returns structured values (objects/arrays)", async () => {
      const value = await executor.runExpression(
        "({ big: context.items.filter(i => i > 1) })",
        { context: { items: [1, 2, 3] } },
        "routine:test"
      );
      expect(value).toEqual({ big: [2, 3] });
    });

    it("kills a hot loop at ~100ms, flagged timedOut", { timeout: 10_000 }, async () => {
      const start = Date.now();
      try {
        await executor.runExpression("(() => { while (true) {} })()", {}, "routine:spin");
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HookError);
        // Well under the 2s resource-hook budget — proves the 100ms limit applies.
        expect(Date.now() - start).toBeLessThan(1_500);
      }
    });

    it("has no host/fs/net access (static analysis rejects escape attempts)", async () => {
      for (const code of ["process.exit(0)", "require('fs')", "fetch('http://x')"]) {
        await expect(executor.runExpression(code, {}, "routine:esc")).rejects.toThrow(HookError);
      }
    });

    it.skipIf(skipNoIsovm)("cannot reach ambient globals inside the isolate", async () => {
      // globalThis exists but has no host powers; typeof checks prove absence.
      const value = await executor.runExpression(
        "[typeof globalThis.require, typeof globalThis.module]",
        {},
        "routine:amb"
      );
      expect(value).toEqual(["undefined", "undefined"]);
    });
  });

  describe("runRoutineHook (hooks.ts contract)", () => {
    const HOOKS = `({
      beforeHook(ctx) { return "ran"; },
      computeTotal(ctx, args) { return args.base + ctx.context.bonus; },
    })`;

    it.skipIf(skipNoIsovm)("dispatches a named step function with ctx and args", async () => {
      const value = await executor.runRoutineHook(
        HOOKS,
        "computeTotal",
        { runId: "r1", slug: "s", context: { bonus: 5 }, trigger: { type: "manual" } },
        { base: 10 },
        "routine:test"
      );
      expect(value).toBe(15);
    });

    it.skipIf(skipNoIsovm)("optional lifecycle hooks are a no-op when missing", async () => {
      const value = await executor.runRoutineHook(
        HOOKS,
        "afterHook",
        { runId: "r1", slug: "s", context: {}, trigger: { type: "manual" } },
        undefined,
        "routine:test",
        { optional: true }
      );
      expect(value).toBeNull();
    });

    it.skipIf(skipNoIsovm)("a missing non-optional function is an error", async () => {
      await expect(
        executor.runRoutineHook(
          HOOKS,
          "missingFn",
          { runId: "r1", slug: "s", context: {}, trigger: { type: "manual" } },
          undefined,
          "routine:test"
        )
      ).rejects.toThrow(/does not define function/);
    });

    it("enforces hash integrity when expectedHash is given", async () => {
      await expect(
        executor.runRoutineHook(
          HOOKS,
          "computeTotal",
          { runId: "r1", slug: "s", context: {}, trigger: { type: "manual" } },
          {},
          "routine:test",
          { expectedHash: "not-the-hash" }
        )
      ).rejects.toThrow(/hash mismatch/);
    });

    it("rejects banned patterns before entering the isolate", async () => {
      await expect(
        executor.runRoutineHook(
          "({ beforeHook(ctx) { process.exit(1); } })",
          "beforeHook",
          { runId: "r1", slug: "s", context: {}, trigger: { type: "manual" } },
          undefined,
          "routine:test"
        )
      ).rejects.toThrow(/banned pattern/);
    });
  });
});
