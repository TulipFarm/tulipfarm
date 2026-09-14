import { describe, expect, it, vi } from "vitest";
import type { StartOimRuntimeDeps } from "./oim-runtime";
import { startOimRuntime } from "./oim-runtime";

function cycle(overrides: Partial<StartOimRuntimeDeps> = {}): StartOimRuntimeDeps {
  return {
    assertReady: vi.fn(async () => undefined),
    recoverRegistrations: vi.fn(async () => undefined),
    pollConnections: vi.fn(async () => undefined),
    superviseWebsockets: vi.fn(async () => undefined),
    drainInbox: vi.fn(async () => undefined),
    loadKnowledgeRegistrations: vi.fn(async () => []),
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    ingressIntervalMs: 60_000,
    knowledgeIntervalMs: 60_000,
    ...overrides,
  };
}

describe("startOimRuntime", () => {
  it("starts all ingress and Knowledge loops after the host contract is ready", async () => {
    const controller = new AbortController();
    const deps = cycle();

    const loops = await startOimRuntime(controller.signal, deps);
    await vi.waitFor(() => {
      expect(deps.recoverRegistrations).toHaveBeenCalledOnce();
      expect(deps.pollConnections).toHaveBeenCalledOnce();
      expect(deps.superviseWebsockets).toHaveBeenCalledOnce();
      expect(deps.drainInbox).toHaveBeenCalledOnce();
      expect(deps.loadKnowledgeRegistrations).toHaveBeenCalledOnce();
    });

    expect(loops.map((loop) => loop.name)).toEqual([
      "oim-registration-recovery",
      "oim-polling-ingress",
      "oim-websocket-ingress",
      "oim-delivery",
      "oim-knowledge-sync",
    ]);

    controller.abort();
    await Promise.all(loops.map((loop) => loop.settled));
  });

  it("fails startup before starting work when the host contract is unavailable", async () => {
    const deps = cycle({
      assertReady: vi.fn(async () => {
        throw new Error("OIM worker contract unavailable");
      }),
    });

    await expect(startOimRuntime(new AbortController().signal, deps)).rejects.toThrow(
      "OIM worker contract unavailable"
    );
    expect(deps.recoverRegistrations).not.toHaveBeenCalled();
    expect(deps.pollConnections).not.toHaveBeenCalled();
    expect(deps.superviseWebsockets).not.toHaveBeenCalled();
    expect(deps.drainInbox).not.toHaveBeenCalled();
    expect(deps.loadKnowledgeRegistrations).not.toHaveBeenCalled();
  });

  it("waits for in-flight ingress and Knowledge work during drain", async () => {
    const controller = new AbortController();
    let releaseIngress: () => void = () => undefined;
    let releaseKnowledge: () => void = () => undefined;
    const ingressWork = new Promise<void>((resolve) => {
      releaseIngress = resolve;
    });
    const knowledgeWork = new Promise<void>((resolve) => {
      releaseKnowledge = resolve;
    });
    const sync = vi.fn(async () => {
      await knowledgeWork;
      return { failures: [] };
    });
    const deps = cycle({
      recoverRegistrations: vi.fn(async () => ingressWork),
      loadKnowledgeRegistrations: vi.fn(async () => [{ id: "knowledge", sync }]),
    });

    const loops = await startOimRuntime(controller.signal, deps);
    await vi.waitFor(() => {
      expect(deps.recoverRegistrations).toHaveBeenCalledOnce();
      expect(sync).toHaveBeenCalledOnce();
    });

    controller.abort();
    let drained = false;
    const draining = Promise.all(loops.map((loop) => loop.settled)).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseIngress();
    releaseKnowledge();
    await draining;
    expect(drained).toBe(true);
  });

  it("contains cycle failures and retries without reporting successful completion", async () => {
    const controller = new AbortController();
    const recoverRegistrations = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const sync = vi.fn(async () => {
      throw new Error("Knowledge unavailable");
    });
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const deps = cycle({
      recoverRegistrations,
      loadKnowledgeRegistrations: vi.fn(async () => [{ id: "knowledge", sync }]),
      log,
      ingressIntervalMs: 1,
      knowledgeIntervalMs: 1,
    });

    const loops = await startOimRuntime(controller.signal, deps);
    await vi.waitFor(() => {
      expect(recoverRegistrations.mock.calls.length).toBeGreaterThan(1);
      expect(sync.mock.calls.length).toBeGreaterThan(1);
    });
    controller.abort();
    await Promise.all(loops.map((loop) => loop.settled));

    expect(log.error).toHaveBeenCalledWith(
      { error: "provider unavailable" },
      "OIM registration recovery failed and will retry"
    );
    expect(log.warn).toHaveBeenCalledWith(
      "OIM Knowledge sync crashed for knowledge",
      expect.objectContaining({ message: "Knowledge unavailable" })
    );
  });
});
