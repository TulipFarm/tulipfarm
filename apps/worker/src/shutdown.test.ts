import { describe, expect, it, vi } from "vitest";
import { drain } from "./shutdown";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A timeout that never fires, so the clean-drain case is asserted without real time passing. */
const neverSleep = (): Promise<void> => new Promise(() => {});

describe("drain", () => {
  it("aborts the loops before waiting on them", async () => {
    const abort = vi.fn();
    await drain({ loops: [], abort, timeoutMs: 1_000, sleep: neverSleep });
    expect(abort).toHaveBeenCalledOnce();
  });

  it("reports a clean drain once every loop settles", async () => {
    const first = deferred();
    const second = deferred();
    const outcome = drain({
      loops: [
        { name: "run-dispatch", settled: first.promise },
        { name: "wait-sweep", settled: second.promise },
      ],
      abort: () => {},
      timeoutMs: 1_000,
      sleep: neverSleep,
    });

    first.resolve();
    second.resolve();

    await expect(outcome).resolves.toEqual({ status: "drained" });
  });

  it("names the loops still in flight when the budget runs out", async () => {
    const finished = deferred();
    const stuck = deferred();
    const timeout = deferred();

    const outcome = drain({
      loops: [
        { name: "run-dispatch", settled: finished.promise },
        { name: "outbox-delivery", settled: stuck.promise },
      ],
      abort: () => {},
      timeoutMs: 15_000,
      sleep: () => timeout.promise,
    });

    finished.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    timeout.resolve();

    await expect(outcome).resolves.toEqual({
      status: "timed_out",
      pending: ["outbox-delivery"],
    });
  });

  it("drains immediately when there is nothing in flight", async () => {
    await expect(
      drain({ loops: [], abort: () => {}, timeoutMs: 1_000, sleep: neverSleep })
    ).resolves.toEqual({ status: "drained" });
  });
});
