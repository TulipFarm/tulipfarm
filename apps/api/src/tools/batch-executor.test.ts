import { describe, expect, it } from "vitest";
import { BatchCoordinator } from "./batch-executor";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("BatchCoordinator", () => {
  it("concurrent reads: both start before either ends", async () => {
    const log: string[] = [];
    const coordinator = new BatchCoordinator();

    const p1 = coordinator.schedule(async () => {
      log.push("1:start");
      await delay(20);
      log.push("1:end");
      return "r1";
    }, false);

    const p2 = coordinator.schedule(async () => {
      log.push("2:start");
      await delay(20);
      log.push("2:end");
      return "r2";
    }, false);

    await Promise.all([p1, p2]);

    expect(log[0]).toBe("1:start");
    expect(log[1]).toBe("2:start"); // both started before either ended
    expect(log).toContain("1:end");
    expect(log).toContain("2:end");
  });

  it("sequential when any mutating: strict order", async () => {
    const log: string[] = [];
    const coordinator = new BatchCoordinator();

    const p1 = coordinator.schedule(async () => {
      log.push("1:start");
      await delay(20);
      log.push("1:end");
      return "r1";
    }, true); // mutating

    const p2 = coordinator.schedule(async () => {
      log.push("2:start");
      await delay(20);
      log.push("2:end");
      return "r2";
    }, false);

    await Promise.all([p1, p2]);

    expect(log).toEqual(["1:start", "1:end", "2:start", "2:end"]);
  });

  it("single read-only tool completes normally", async () => {
    const coordinator = new BatchCoordinator();
    const result = await coordinator.schedule(async () => "solo", false);
    expect(result).toBe("solo");
  });

  it("single mutating tool completes normally", async () => {
    const coordinator = new BatchCoordinator();
    const result = await coordinator.schedule(async () => "solo-mut", true);
    expect(result).toBe("solo-mut");
  });

  it("resolved values flow through correctly", async () => {
    const coordinator = new BatchCoordinator();
    const [a, b] = await Promise.all([
      coordinator.schedule(async () => 42, false),
      coordinator.schedule(async () => "hello", false),
    ]);
    expect(a).toBe(42);
    expect(b).toBe("hello");
  });

  it("error in sequential batch propagates; subsequent tasks still run", async () => {
    const log: string[] = [];
    const coordinator = new BatchCoordinator();

    const p1 = coordinator.schedule(async () => {
      throw new Error("boom");
    }, true);

    const p2 = coordinator.schedule(async () => {
      log.push("ran");
      return "ok";
    }, false);

    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
    expect(log).toContain("ran");
  });

  it("two separate microtask ticks produce independent batches", async () => {
    const log: string[] = [];
    const coordinator = new BatchCoordinator();

    // First batch
    const p1 = coordinator.schedule(async () => {
      log.push("A");
      return "A";
    }, false);
    await p1;

    // Second batch (scheduled after first flush)
    const p2 = coordinator.schedule(async () => {
      log.push("B");
      return "B";
    }, false);
    await p2;

    expect(log).toEqual(["A", "B"]);
  });
});
