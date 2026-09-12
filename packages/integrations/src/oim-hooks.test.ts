import type { OimHook, OimManifest } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { runOimHookPhase } from "./oim-hooks";

function manifest(hooks?: readonly OimHook[]): OimManifest {
  return {
    oimVersion: "1.0",
    metadata: {
      id: "weather",
      name: "Weather",
      description: "Weather provider",
      version: "1.0.0",
    },
    ...(hooks === undefined ? {} : { hooks }),
  } as OimManifest;
}

describe("runOimHookPhase", () => {
  it("returns an absent result when the phase has no declaration", async () => {
    await expect(
      runOimHookPhase({
        manifest: manifest(),
        kind: "response_normalize",
        input: { payload: { temperature: 21 }, safeHeaders: {} },
      })
    ).resolves.toEqual({ executed: false });
  });

  it("fails closed when a declared phase has no runner", async () => {
    await expect(
      runOimHookPhase({
        manifest: manifest([
          {
            kind: "response_normalize",
            file: "hooks/normalize.js",
            export: "normalize",
          },
        ]),
        kind: "response_normalize",
        input: { payload: { temperature: 21 }, safeHeaders: {} },
      })
    ).rejects.toThrow("response_normalize Hook is declared but no trusted runner is configured");
  });

  it("passes the exact declaration and phase input to the runner", async () => {
    const hook = {
      kind: "content_map",
      file: "hooks/content.js",
      export: "mapContent",
    } as const;
    const run = vi.fn(async () => ({ title: "Forecast" }));

    await expect(
      runOimHookPhase({
        manifest: manifest([hook]),
        kind: "content_map",
        input: { operationId: "list", itemId: "item-1", payload: { name: "Forecast" } },
        runner: { run },
      })
    ).resolves.toEqual({ executed: true, value: { title: "Forecast" } });
    expect(run).toHaveBeenCalledWith(hook, {
      operationId: "list",
      itemId: "item-1",
      payload: { name: "Forecast" },
    });
  });

  it("requires an exact named declaration", async () => {
    await expect(
      runOimHookPhase({
        manifest: manifest([
          {
            kind: "response_normalize",
            file: "hooks/normalize.js",
            export: "normalize",
          },
        ]),
        kind: "response_normalize",
        exportName: "other",
        input: { payload: {}, safeHeaders: {} },
        runner: { run: vi.fn() },
      })
    ).rejects.toThrow('response_normalize Hook export "other" is not declared');
  });

  it("fails closed for an ambiguous unnamed phase", async () => {
    await expect(
      runOimHookPhase({
        manifest: manifest([
          {
            kind: "response_normalize",
            file: "hooks/one.js",
            export: "one",
          },
          {
            kind: "response_normalize",
            file: "hooks/two.js",
            export: "two",
          },
        ]),
        kind: "response_normalize",
        input: { payload: {}, safeHeaders: {} },
        runner: { run: vi.fn() },
      })
    ).rejects.toThrow("response_normalize Hook declaration is ambiguous");
  });
});
