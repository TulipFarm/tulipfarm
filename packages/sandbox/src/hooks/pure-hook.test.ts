import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HookError, HookExecutor, resolveHookWorkerPath } from "./executor";

const WORKER_PATH = resolveHookWorkerPath(__dirname, "worker");

function reviewed(
  source: string,
  exportName: string,
  input: unknown,
  breakerKey = `pure:${exportName}:${createHash("sha256").update(source).digest("hex").slice(0, 12)}`
) {
  return {
    source,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    exportName,
    input,
    breakerKey,
  };
}

describe("pure Hook execution", () => {
  let executor: HookExecutor;

  beforeAll(() => {
    executor = new HookExecutor({ workerPath: WORKER_PATH });
  });

  afterAll(async () => {
    await executor.close();
  });

  afterEach(() => {
    process.env.HOOKS_DISABLED = undefined;
  });

  it("executes only the reviewed module export with JSON input and output", async () => {
    const source = `
      export function shape(input) {
        return { method: "POST", body: { title: input.title.trim() } };
      }
      export function other() {
        throw new Error("wrong export");
      }
    `;

    await expect(
      executor.runPureHook(reviewed(source, "shape", { title: "  hello  " }))
    ).resolves.toEqual({
      method: "POST",
      body: { title: "hello" },
    });
  });

  it("refuses source whose SHA-256 differs from the reviewed digest", async () => {
    const request = reviewed("export function validate(input) { return input; }", "validate", {});

    await expect(
      executor.runPureHook({
        ...request,
        source: "export function validate() { return { allowed: true }; }",
      })
    ).rejects.toThrow("hook hash mismatch");
  });

  it("refuses an export other than the reviewed export", async () => {
    const source = "export function normalize(input) { return input; }";

    await expect(executor.runPureHook(reviewed(source, "classify", {}))).rejects.toThrow(
      'does not define function "classify"'
    );
  });

  it.each([
    [
      "static imports",
      'import value from "./dependency.js"; export function run() { return value; }',
    ],
    ["dynamic imports", 'export function run() { return import("./dependency.js"); }'],
    ["CommonJS imports", 'export function run() { return require("node:fs"); }'],
  ])("refuses %s", async (_label, source) => {
    await expect(executor.runPureHook(reviewed(source, "run", null))).rejects.toThrow(HookError);
  });

  it.each([
    ["process", "export function run() { return process.env.SECRET; }"],
    [
      "filesystem globals",
      'export function run() { return require("node:fs").readFileSync("."); }',
    ],
    ["network globals", 'export function run() { return fetch("https://example.com"); }'],
    ["timers", "export function run() { return setTimeout(() => 1, 1); }"],
    ["the clock", "export function run() { return Date.now(); }"],
    ["randomness", "export function run() { return Math.random(); }"],
    ["browser storage", 'export function run() { return localStorage.getItem("secret"); }'],
    ["a Secret API", 'export function run() { return Secret.read("credential"); }'],
  ])("does not expose %s", async (_label, source) => {
    await expect(executor.runPureHook(reviewed(source, "run", null))).rejects.toThrow(HookError);
  });

  it("times out an infinite loop", { timeout: 10_000 }, async () => {
    const source = "export function run() { while (true) {} }";

    try {
      await executor.runPureHook(reviewed(source, "run", null, "pure:loop"));
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HookError);
      expect((error as HookError).timedOut).toBe(true);
    }
  });

  it("bounds memory growth", { timeout: 10_000 }, async () => {
    const source = `
      export function run() {
        const values = [];
        while (true) values.push(new Array(100000).fill("memory"));
      }
    `;

    await expect(
      executor.runPureHook(reviewed(source, "run", null, "pure:memory"))
    ).rejects.toThrow(/memory|disposed|timed out/i);
  });

  it("starts from a fresh deterministic module state for every call", async () => {
    const source = `
      let calls = 0;
      export function run(input) {
        calls += 1;
        return { calls, input };
      }
    `;
    const request = reviewed(source, "run", { stable: true }, "pure:determinism");

    const first = await executor.runPureHook(request);
    const second = await executor.runPureHook(request);

    expect(first).toEqual({ calls: 1, input: { stable: true } });
    expect(second).toEqual(first);
  });

  it.each([
    ["undefined", undefined],
    ["a non-finite number", Number.POSITIVE_INFINITY],
    ["a Date object", new Date("2026-01-01T00:00:00.000Z")],
  ])("refuses %s input", async (_label, input) => {
    const source = "export function run(input) { return input; }";

    await expect(executor.runPureHook(reviewed(source, "run", input))).rejects.toThrow(
      "hook input must be a JSON value"
    );
  });

  it.each([
    ["undefined", "export function run() {}"],
    ["BigInt", "export function run() { return 1n; }"],
    ["a function", "export function run() { return () => 1; }"],
  ])("refuses %s output", async (_label, source) => {
    await expect(executor.runPureHook(reviewed(source, "run", null))).rejects.toThrow(HookError);
  });

  it("refuses oversized input and output", async () => {
    const identity = "export function run(input) { return input; }";
    const oversized = "x".repeat(300 * 1024);

    await expect(executor.runPureHook(reviewed(identity, "run", oversized))).rejects.toThrow(
      "hook input exceeds"
    );

    const output = `export function run() { return ${JSON.stringify(oversized)}; }`;
    await expect(
      executor.runPureHook(reviewed(output, "run", null, "pure:large-output"))
    ).rejects.toThrow("hook output exceeds");
  });

  it("fails closed when the global hook switch is disabled", async () => {
    process.env.HOOKS_DISABLED = "true";
    const source = "export function authorize(input) { return input; }";

    await expect(
      executor.runPureHook(reviewed(source, "authorize", { allowed: true }))
    ).rejects.toThrow("mandatory pure hook execution is disabled");
  });

  it("fails closed after the circuit breaker opens", async () => {
    const source = 'export function authorize() { throw new Error("denied"); }';
    const request = reviewed(source, "authorize", { allowed: true }, "pure:mandatory-auth");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await executor.runPureHook(request).catch(() => {});
    }

    await expect(executor.runPureHook(request)).rejects.toThrow(
      "pure hook disabled by circuit breaker"
    );
  });
});
