import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// isolated-vm 7.x ships prebuilds for Node 24 (abi137) and Node 26 (abi147) but not Node 25 (abi141).
// Tests that require the isolate to actually execute and return a successful result must be
// skipped on Node 25; tests that only require the error path still pass via the HookError wrappers.
const nodeMajor = parseInt(process.version.slice(1).split(".")[0], 10);
const skipNoIsovm = nodeMajor === 25;

import { HookError, HookExecutor } from "./hook-executor.js";

// HookExecutor needs a worker thread running hook-worker.ts via tsx.
// Tests for AC-V1-003 (timeout) and AC-V1-004 (sandbox isolation) don't need a database.
// We pass a fake connection string — the worker only connects when ctx.resources.get is called.
const FAKE_DATABASE_URL = "postgresql://localhost:5432/test";

describe("HookExecutor", () => {
  let executor: HookExecutor;

  // Production keeps one executor worker alive for the process lifetime. Reusing it here also
  // avoids isolated-vm's known worker-thread teardown race (#464) between individual tests.
  beforeAll(() => {
    executor = new HookExecutor(FAKE_DATABASE_URL);
  });

  afterAll(async () => {
    await executor.close();
  });

  describe("AC-V1-003: timeout", () => {
    it("kills hook with infinite loop at ~2s", { timeout: 10_000 }, async () => {
      const hookSource = `({
        async before() { while (true) {} }
      })`;

      await expect(executor.runBeforeHook(hookSource, "ticket", { title: "test" })).rejects.toThrow(
        HookError
      );
    });

    it.skipIf(skipNoIsovm)(
      "throws HookError with timedOut=true for infinite loop",
      { timeout: 10_000 },
      async () => {
        const hookSource = `({
        async before() { while (true) {} }
      })`;

        try {
          await executor.runBeforeHook(hookSource, "ticket", { title: "test" });
          expect.fail("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(HookError);
          expect((err as HookError).timedOut).toBe(true);
          expect((err as HookError).message).toBe("hook timed out");
        }
      }
    );
  });

  describe("AC-V1-004: sandbox isolation", () => {
    it("blocks require('fs')", async () => {
      const hookSource = `({
        async before() { require('fs'); }
      })`;

      await expect(executor.runBeforeHook(hookSource, "ticket", { title: "test" })).rejects.toThrow(
        HookError
      );
    });

    it("blocks process.env access", async () => {
      const hookSource = `({
        async before() { const x = process.env.SECRET; }
      })`;

      await expect(executor.runBeforeHook(hookSource, "ticket", { title: "test" })).rejects.toThrow(
        HookError
      );
    });

    it("blocks globalThis.process", async () => {
      const hookSource = `({
        async before(ctx) { const x = globalThis.process; if (x) x.env.SECRET; }
      })`;

      // L3 catches 'process' keyword before isolate; throws HookError
      await expect(executor.runBeforeHook(hookSource, "ticket", { title: "test" })).rejects.toThrow(
        HookError
      );
    });
  });

  describe.skipIf(skipNoIsovm)("before hook behaviour", () => {
    it("returns record unmodified when no hook fn", async () => {
      const hookSource = "({})";
      const record = { title: "hello" };
      const result = await executor.runBeforeHook(hookSource, "ticket", record);
      expect(result).toMatchObject(record);
    });

    it("applies ctx.patch mutations to record", async () => {
      const hookSource = `({
        async before(ctx) {
          ctx.patch({ enriched: true, upper: ctx.record.title.toUpperCase() });
        }
      })`;

      const result = await executor.runBeforeHook(hookSource, "ticket", { title: "hello" });
      expect(result.enriched).toBe(true);
      expect(result.upper).toBe("HELLO");
      expect(result.title).toBe("hello");
    });

    it("ctx.hash returns sha256 hex", async () => {
      const hookSource = `({
        async before(ctx) {
          ctx.patch({ digest: ctx.hash('hello') });
        }
      })`;

      const result = await executor.runBeforeHook(hookSource, "ticket", { title: "hello" });
      expect(result.digest).toBe(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
      );
    });

    it("ctx.uuid returns a UUID string", async () => {
      const hookSource = `({
        async before(ctx) {
          ctx.patch({ uid: ctx.uuid() });
        }
      })`;

      const result = await executor.runBeforeHook(hookSource, "ticket", { title: "hello" });
      expect(result.uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("ctx.now is a number (frozen timestamp)", async () => {
      const hookSource = `({
        async before(ctx) {
          ctx.patch({ ts: ctx.now });
        }
      })`;

      const before = Date.now();
      const result = await executor.runBeforeHook(hookSource, "ticket", { title: "hello" });
      const after = Date.now();
      expect(typeof result.ts).toBe("number");
      expect(result.ts as number).toBeGreaterThanOrEqual(before);
      expect(result.ts as number).toBeLessThanOrEqual(after);
    });
  });

  describe.skipIf(skipNoIsovm)("after hook behaviour", () => {
    it("runs after hook without throwing (side-effect only)", async () => {
      const hookSource = `({
        async after(ctx) { /* no-op */ }
      })`;

      await expect(
        executor.runAfterHook(hookSource, "ticket", { id: "1", title: "hello" })
      ).resolves.toBeUndefined();
    });
  });

  describe("AC: worker thread", () => {
    it("executor uses a Worker (off main event loop)", () => {
      // Structural verification: executor spawns a Worker
      // biome-ignore lint/complexity/useLiteralKeys: accessing private property in test
      expect(executor["worker"]).toBeInstanceOf(Worker);
    });
  });

  describe("L3: static analysis pre-filter", () => {
    it("rejects hook with require() before isolate runs", async () => {
      const hookSource = `({ async before() { require('net'); } })`;
      const err = await executor
        .runBeforeHook(hookSource, "ticket", { title: "test" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(HookError);
      expect(err.message).toContain("banned pattern");
    });

    it("rejects hook with eval() before isolate runs", async () => {
      const hookSource = `({ async before() { eval('1+1'); } })`;
      await expect(executor.runBeforeHook(hookSource, "ticket", { title: "test" })).rejects.toThrow(
        HookError
      );
    });

    it("rejects hook with setTimeout before isolate runs", async () => {
      const hookSource = "({ async before() { setTimeout(() => {}, 0); } })";
      await expect(executor.runBeforeHook(hookSource, "ticket", { title: "test" })).rejects.toThrow(
        HookError
      );
    });

    it.skipIf(skipNoIsovm)("allows clean hook through L3", async () => {
      const hookSource = "({ async before(ctx) { ctx.patch({ ok: true }); } })";
      const result = await executor.runBeforeHook(hookSource, "ticket", { title: "test" });
      expect(result.ok).toBe(true);
    });
  });

  describe("L5: circuit breaker", () => {
    const FAIL_HOOK = `({ async before() { throw new Error('deliberate'); } })`;

    it("disables hook after 3 consecutive failures", async () => {
      const type = "cb-resource";
      for (let i = 0; i < 3; i++) {
        await executor.runBeforeHook(FAIL_HOOK, type, {}).catch(() => {});
      }
      const err = await executor.runBeforeHook(FAIL_HOOK, type, {}).catch((e) => e);
      expect(err).toBeInstanceOf(HookError);
      expect(err.message).toBe("hook disabled by circuit breaker");
    });

    it.skipIf(skipNoIsovm)("resets failure count on success", async () => {
      const type = "cb-reset";
      const GOOD_HOOK = "({})";
      // 2 failures then a success then a failure — should not trip breaker
      await executor.runBeforeHook(FAIL_HOOK, type, {}).catch(() => {});
      await executor.runBeforeHook(FAIL_HOOK, type, {}).catch(() => {});
      await executor.runBeforeHook(GOOD_HOOK, type, {}); // success resets
      await executor.runBeforeHook(FAIL_HOOK, type, {}).catch(() => {});
      // Only 1 failure after reset — should NOT be circuit-broken
      const result = await executor.runBeforeHook(GOOD_HOOK, type, {});
      expect(result).toBeDefined();
    });
  });

  describe("L5: global kill switch", () => {
    afterEach(() => {
      process.env.HOOKS_DISABLED = undefined;
    });

    it("skips hook execution when HOOKS_DISABLED=true", async () => {
      process.env.HOOKS_DISABLED = "true";
      const hookSource = "({ async before() { throw new Error('should not run'); } })";
      const record = { title: "test" };
      const result = await executor.runBeforeHook(hookSource, "ticket", record);
      expect(result).toEqual(record);
    });

    it("runAfterHook resolves silently when HOOKS_DISABLED=true", async () => {
      process.env.HOOKS_DISABLED = "true";
      const hookSource = "({ async after() { throw new Error('should not run'); } })";
      await expect(
        executor.runAfterHook(hookSource, "ticket", { id: "1", title: "test" })
      ).resolves.toBeUndefined();
    });
  });

  describe("L5: hash integrity", () => {
    it("throws HookError when expectedHash does not match hookSource", async () => {
      const hookSource = "({ async before(ctx) { ctx.patch({ ok: true }); } })";
      const wrongHash = "deadbeef".repeat(8);
      const err = await executor
        .runBeforeHook(hookSource, "ticket", { title: "test" }, wrongHash)
        .catch((e) => e);
      expect(err).toBeInstanceOf(HookError);
      expect(err.message).toBe("hook hash mismatch");
    });

    it.skipIf(skipNoIsovm)("runs hook when expectedHash matches", async () => {
      const hookSource = "({ async before(ctx) { ctx.patch({ ok: true }); } })";
      const correctHash = createHash("sha256").update(hookSource).digest("hex");
      const result = await executor.runBeforeHook(
        hookSource,
        "ticket",
        { title: "test" },
        correctHash
      );
      expect(result.ok).toBe(true);
    });
  });
});
