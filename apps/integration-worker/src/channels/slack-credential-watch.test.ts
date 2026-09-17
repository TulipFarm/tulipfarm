import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchForSlackChannelCredential } from "./index";

const state = vi.hoisted(() => ({
  credential: { configured: true, botToken: "bot-one", appToken: "app-one" },
  starts: [] as { token: string; signal: AbortSignal }[],
  sockets: [] as { appToken: string }[],
  readsFail: false,
  drainGate: undefined as Promise<void> | undefined,
}));

function untilAbort(signal: AbortSignal): Promise<void> {
  const gate = state.drainGate;
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true })
  ).then(() => gate);
}

vi.mock("../internal/client", () => ({
  InternalApiClient: class {
    async require() {
      if (state.readsFail) throw new Error("credential service unavailable");
      return { ...state.credential };
    }
  },
}));
vi.mock("../slack/socket-transport", () => ({
  SlackSocketTransport: class {
    constructor(options: { appToken: string }) {
      state.sockets.push({ appToken: options.appToken });
    }
  },
}));
vi.mock("../slack/worker", () => ({
  SlackSocketWorker: class {
    run(signal: AbortSignal) {
      return untilAbort(signal);
    }
  },
}));
vi.mock("./delivery-poll-loop", async (original) => ({
  ...(await original<typeof import("./delivery-poll-loop")>()),
  startDeliveryPollLoop(signal: AbortSignal, deps: { credential: string }) {
    state.starts.push({ token: deps.credential, signal });
    return { name: "delivery", settled: untilAbort(signal) };
  },
}));
vi.mock("../slack/home-publisher", () => ({
  SlackHomePublisher: class {},
  startSlackHomePublishLoop: (signal: AbortSignal) => ({
    name: "home",
    settled: untilAbort(signal),
  }),
}));
vi.mock("./surface-interaction-recovery", () => ({
  startSurfaceInteractionRecoveryLoop: (signal: AbortSignal) => ({
    name: "surface",
    settled: untilAbort(signal),
  }),
}));
vi.mock("./command-response-recovery", () => ({
  startCommandResponseRecoveryLoop: (signal: AbortSignal) => ({
    name: "command",
    settled: untilAbort(signal),
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  state.starts.length = 0;
  state.sockets.length = 0;
  state.readsFail = false;
  state.drainGate = undefined;
  state.credential = { configured: true, botToken: "bot-one", appToken: "app-one" };
});

describe("Slack credential lifecycle composition", () => {
  it("waits for the old generation's in-flight work before starting its replacement", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    state.drainGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    const watcher = watchForSlackChannelCredential(
      {
        businessId: "business-1",
        pool: {} as Pool,
        internalApiUrl: "http://internal.invalid",
        internalApiCredential: "worker-fixture",
        signal: controller.signal,
        log: { info: vi.fn(), warn: vi.fn() },
      },
      vi.fn(),
      100
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      state.credential.botToken = "bot-two";
      await vi.advanceTimersByTimeAsync(100);
      expect(state.starts[0]?.signal.aborted).toBe(true);
      expect(state.starts).toHaveLength(1);
      state.drainGate = undefined;
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.starts.map((start) => start.token)).toEqual(["bot-one", "bot-two"]);
    } finally {
      finish();
      controller.abort();
      await watcher.settled;
    }
  });

  it("keeps watching after connection and drains the old generation before rotating both tokens", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const watcher = watchForSlackChannelCredential(
      {
        businessId: "business-1",
        pool: {} as Pool,
        internalApiUrl: "http://internal.invalid",
        internalApiCredential: "worker-fixture",
        signal: controller.signal,
        log: { info: vi.fn(), warn: vi.fn() },
      },
      vi.fn(),
      100
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(state.starts.map((start) => start.token)).toEqual(["bot-one"]);
      await vi.advanceTimersByTimeAsync(100);
      expect(state.starts).toHaveLength(1);
      state.credential = { configured: true, botToken: "bot-two", appToken: "app-two" };
      await vi.advanceTimersByTimeAsync(100);
      expect(state.starts.map((start) => start.token)).toEqual(["bot-one", "bot-two"]);
      expect(state.starts[0]?.signal.aborted).toBe(true);
      expect(state.sockets).toEqual([{ appToken: "app-one" }, { appToken: "app-two" }]);
      state.credential.configured = false;
      await vi.advanceTimersByTimeAsync(100);
      expect(state.starts[1]?.signal.aborted).toBe(true);
      state.credential.configured = true;
      await vi.advanceTimersByTimeAsync(100);
      expect(state.starts).toHaveLength(3);
      state.readsFail = true;
      await vi.advanceTimersByTimeAsync(100);
      expect(state.starts[2]?.signal.aborted).toBe(true);
      expect(state.starts).toHaveLength(3);
      state.readsFail = false;
      await vi.advanceTimersByTimeAsync(100);
      expect(state.starts).toHaveLength(4);
    } finally {
      controller.abort();
      await watcher.settled;
    }
    expect(state.starts.every((start) => start.signal.aborted)).toBe(true);
  });
});
