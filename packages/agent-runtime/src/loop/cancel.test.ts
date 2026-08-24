import { describe, expect, it } from "vitest";
import { CANCELLED_REASON, watchForCancel } from "./cancel";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("watchForCancel", () => {
  it("aborts once the Run reports that it is cancelling", async () => {
    let stopping = false;
    const watch = watchForCancel(async () => stopping, 1);

    expect(watch.cancelled()).toBe(false);
    stopping = true;
    await settle(25);

    expect(watch.cancelled()).toBe(true);
    expect(watch.signal.reason).toBe(CANCELLED_REASON);
    watch.stop();
  });

  it("stays quiet while the Run is healthy", async () => {
    const watch = watchForCancel(async () => false, 1);
    await settle(25);

    expect(watch.cancelled()).toBe(false);
    watch.stop();
  });

  it("ignores a status read that fails, rather than ending a Turn nobody stopped", async () => {
    const watch = watchForCancel(async () => {
      throw new Error("database unavailable");
    }, 1);
    await settle(25);

    expect(watch.cancelled()).toBe(false);
    watch.stop();
  });

  it("keeps one read in flight, so a slow one cannot stack a queue behind it", async () => {
    let inFlight = 0;
    let peak = 0;
    const watch = watchForCancel(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await settle(15);
      inFlight -= 1;
      return false;
    }, 1);

    await settle(60);
    watch.stop();
    expect(peak).toBe(1);
  });

  it("stops polling once the call it watched is over", async () => {
    let polls = 0;
    const watch = watchForCancel(async () => {
      polls += 1;
      return false;
    }, 1);

    await settle(25);
    watch.stop();
    const atStop = polls;
    await settle(25);

    expect(polls).toBe(atStop);
    expect(atStop).toBeGreaterThan(0);
  });
});
