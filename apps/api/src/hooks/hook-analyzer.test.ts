import { describe, expect, it } from "vitest";
import { HookAnalysisError, analyzeHook } from "./hook-analyzer.js";

describe("analyzeHook", () => {
  describe("banned patterns", () => {
    const cases: [string, string][] = [
      ["require(", `({ before() { require('fs'); } })`],
      ["import(", `({ before() { import('net'); } })`],
      ["eval(", `({ before() { eval('1+1'); } })`],
      ["Function(", `({ before() { new Function('return 1')(); } })`],
      ["process", "({ before() { process.env.SECRET; } })"],
      ["global", "({ before() { global.x; } })"],
      ["Buffer", `({ before() { Buffer.from('x'); } })`],
      ["__dirname", "({ before() { __dirname; } })"],
      ["__filename", "({ before() { __filename; } })"],
      ["fetch(", `({ before() { fetch('http://evil.com'); } })`],
      ["XMLHttpRequest", "({ before() { new XMLHttpRequest(); } })"],
      ["setTimeout", "({ before() { setTimeout(() => {}, 0); } })"],
      ["setInterval", "({ before() { setInterval(() => {}, 0); } })"],
      ["setImmediate", "({ before() { setImmediate(() => {}); } })"],
      ["queueMicrotask", "({ before() { queueMicrotask(() => {}); } })"],
    ];

    for (const [label, source] of cases) {
      it(`throws HookAnalysisError for ${label}`, () => {
        expect(() => analyzeHook(source)).toThrow(HookAnalysisError);
      });
    }
  });

  describe("clean hooks", () => {
    it("allows a hook with no banned patterns", () => {
      const source = `({
        async before(ctx) {
          ctx.patch({ upper: ctx.record.title.toUpperCase() });
        },
        async after(ctx) {
          ctx.hash(ctx.record.title);
        }
      })`;
      expect(() => analyzeHook(source)).not.toThrow();
    });

    it("allows empty hook object", () => {
      expect(() => analyzeHook("({})")).not.toThrow();
    });

    it("allows hook using ctx.uuid and ctx.now", () => {
      const source = "({ async before(ctx) { ctx.patch({ id: ctx.uuid(), ts: ctx.now }); } })";
      expect(() => analyzeHook(source)).not.toThrow();
    });
  });
});
