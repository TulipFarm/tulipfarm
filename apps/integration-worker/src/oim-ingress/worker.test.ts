import { describe, expect, it, vi } from "vitest";
import { OimIngressWorker, startOimIngressLoops } from "./worker";

describe("OimIngressWorker", () => {
  it("recovers registrations, polls, supervises sockets, then drains durable deliveries", async () => {
    const order: string[] = [];
    const worker = new OimIngressWorker({
      cycle: {
        recoverRegistrations: async () => {
          order.push("registrations");
          return { processed: 1 };
        },
        pollConnections: async () => {
          order.push("polling");
          return { recorded: 2 };
        },
        superviseWebsockets: async () => {
          order.push("websockets");
          return { supervised: 0 };
        },
        drainInbox: async () => {
          order.push("inbox");
          return { dispatched: 2 };
        },
      },
      log: { info: vi.fn(), error: vi.fn() },
    });

    await expect(worker.runOnce()).resolves.toEqual({
      registrations: { processed: 1 },
      polling: { recorded: 2 },
      websockets: { supervised: 0 },
      inbox: { dispatched: 2 },
    });
    expect(order).toEqual(["registrations", "polling", "websockets", "inbox"]);
  });

  it("stops promptly when shutdown aborts the wait", async () => {
    const controller = new AbortController();
    const cycle = {
      recoverRegistrations: vi.fn(async () => 0),
      pollConnections: vi.fn(async () => 0),
      superviseWebsockets: vi.fn(async () => 0),
      drainInbox: vi.fn(async () => 0),
    };
    const worker = new OimIngressWorker({
      cycle,
      log: { info: vi.fn(), error: vi.fn() },
      intervalMs: 60_000,
    });

    const running = worker.run(controller.signal);
    await vi.waitFor(() => expect(cycle.drainInbox).toHaveBeenCalledOnce());
    controller.abort();
    await running;

    expect(cycle.recoverRegistrations).toHaveBeenCalledOnce();
    expect(cycle.pollConnections).toHaveBeenCalledOnce();
    expect(cycle.superviseWebsockets).toHaveBeenCalledOnce();
    expect(cycle.drainInbox).toHaveBeenCalledOnce();
  });

  it("creates independent drainable loops so one failing task cannot starve the others", async () => {
    const controller = new AbortController();
    const cycle = {
      recoverRegistrations: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
      pollConnections: vi.fn(async () => 2),
      superviseWebsockets: vi.fn(async () => 0),
      drainInbox: vi.fn(async () => 3),
    };
    const error = vi.fn();
    const loops = startOimIngressLoops(controller.signal, {
      cycle,
      log: { info: vi.fn(), error },
      intervalMs: 60_000,
    });

    await vi.waitFor(() => {
      expect(cycle.recoverRegistrations).toHaveBeenCalledOnce();
      expect(cycle.pollConnections).toHaveBeenCalledOnce();
      expect(cycle.superviseWebsockets).toHaveBeenCalledOnce();
      expect(cycle.drainInbox).toHaveBeenCalledOnce();
    });
    controller.abort();
    await Promise.all(loops.map((loop) => loop.settled));

    expect(loops.map((loop) => loop.name)).toEqual([
      "oim-registration-recovery",
      "oim-polling-ingress",
      "oim-websocket-ingress",
      "oim-delivery",
    ]);
    expect(error).toHaveBeenCalledWith(
      { error: "provider unavailable" },
      "OIM registration recovery failed and will retry"
    );
  });
});
