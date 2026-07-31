import { EventEmitter } from "node:events";
import type { GuardrailsService } from "@tulipfarm/agent-runtime";
import type { SoulLoader } from "@tulipfarm/soul";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerGuardrailsReload } from "./reload";

const flush = () => new Promise((r) => setImmediate(r));

const guardrailsConfig = {
  input: [{ guard: "prompt_injection", sensitivity: "medium" }],
};

let gitSync: EventEmitter;
let soulLoader: { reload: ReturnType<typeof vi.fn>; guardrailsConfig: Record<string, unknown> };
let guardrails: { init: ReturnType<typeof vi.fn> };
let log: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

beforeEach(() => {
  gitSync = new EventEmitter();
  soulLoader = { reload: vi.fn().mockResolvedValue(undefined), guardrailsConfig };
  guardrails = { init: vi.fn() };
  log = { error: vi.fn(), warn: vi.fn() };
});

function register(): void {
  registerGuardrailsReload(
    gitSync,
    soulLoader as unknown as SoulLoader,
    guardrails as unknown as GuardrailsService,
    log as unknown as Parameters<typeof registerGuardrailsReload>[3]
  );
}

describe("registerGuardrailsReload", () => {
  it("reloads the soul then re-inits guardrails with the new config on soul.synced", async () => {
    register();

    gitSync.emit("soul.synced");
    await flush();

    expect(soulLoader.reload).toHaveBeenCalledTimes(1);
    expect(guardrails.init).toHaveBeenCalledTimes(1);
    expect(guardrails.init).toHaveBeenCalledWith(guardrailsConfig, log);
    // reload runs before init
    expect(soulLoader.reload.mock.invocationCallOrder[0]).toBeLessThan(
      guardrails.init.mock.invocationCallOrder[0]
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("catches init errors (non-fatal) and logs them", async () => {
    guardrails.init.mockImplementation(() => {
      throw new Error("boom");
    });
    register();

    expect(() => gitSync.emit("soul.synced")).not.toThrow();
    await flush();

    expect(soulLoader.reload).toHaveBeenCalledTimes(1);
    expect(guardrails.init).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "guardrails reload failed");
  });
});
