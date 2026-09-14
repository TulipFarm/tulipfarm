import type { OimManifest, OimWebsocketIngress } from "@tulipfarm/schema";
import type { RecordedDelivery, VerifiedWebhookDeliveryInput } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import type { VerifiedProviderIdentity } from "./receiver";
import {
  acceptWebsocketFrame,
  type ResolvedWebsocketIngress,
  superviseWebsocketConnection,
  WebsocketFrameError,
  type WebsocketSocket,
  type WebsocketSupervisorStatePort,
  websocketAcknowledgement,
  websocketReconnectDelaySeconds,
} from "./websocket-service";

const identity: VerifiedProviderIdentity = {
  externalTenantId: "tenant-1",
  externalAccountId: "account-1",
};

const ingress: OimWebsocketIngress = {
  kind: "websocket",
  operationId: "open-socket",
  urlPointer: "/url",
  eventTypes: [
    {
      type: "message.created",
      selector: { pointer: "/type", equals: "message_created" },
      schema: { type: "object" },
    },
  ],
  deduplication: { kind: "body_pointer", bodyPointer: "/envelope_id" },
  acknowledgement: {
    correlationPointer: "/envelope_id",
    template: '{"envelope_id":"{correlation}"}',
  },
  reconnect: { maxAttempts: 3, initialDelaySeconds: 1, maxDelaySeconds: 8 },
};

const source: ResolvedWebsocketIngress = {
  businessId: "business-1",
  connectionId: "connection-1",
  integrationId: "realtime",
  integrationMajorVersion: 1,
  manifest: {} as OimManifest,
  ingress,
  verifiedIdentity: identity,
};

function recorded(accepted: boolean): RecordedDelivery {
  return { accepted, delivery: {} as RecordedDelivery["delivery"] };
}

class FakeState implements WebsocketSupervisorStatePort {
  readonly recorded: VerifiedWebhookDeliveryInput[] = [];
  readonly fences: { readonly holderToken: string; readonly now?: Date }[] = [];
  readonly seen = new Set<string>();
  acquireResult = true;
  renewResult = true;
  released = 0;

  acquire = vi.fn(async () => this.acquireResult);
  renew = vi.fn(async () => this.renewResult);
  release = vi.fn(async () => {
    this.released += 1;
    return true;
  });

  recordFrameIfActive = vi.fn(
    async (
      _key: Parameters<WebsocketSupervisorStatePort["recordFrameIfActive"]>[0],
      input: VerifiedWebhookDeliveryInput,
      fence: { readonly holderToken: string; readonly now?: Date }
    ): Promise<RecordedDelivery> => {
      this.recorded.push(input);
      this.fences.push(fence);
      if (this.seen.has(input.deduplicationKey ?? "")) return recorded(false);
      this.seen.add(input.deduplicationKey ?? "");
      return recorded(true);
    }
  );
}

function controllableSocket(): {
  socket: WebsocketSocket;
  push: (frame: string) => void;
  sent: string[];
  isClosed: () => boolean;
} {
  const queue: string[] = [];
  const sent: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const socket: WebsocketSocket = {
    frames: async function* () {
      while (!closed) {
        while (queue.length > 0 && !closed) {
          const frame = queue.shift();
          if (frame !== undefined) yield frame;
        }
        if (closed) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    send: async (frame) => {
      sent.push(frame);
    },
    close: async () => {
      closed = true;
      wake?.();
      wake = null;
    },
  };
  return {
    socket,
    push: (frame) => {
      queue.push(frame);
      wake?.();
      wake = null;
    },
    sent,
    isClosed: () => closed,
  };
}

function socketFrom(frames: string[]): { socket: WebsocketSocket; sent: string[] } {
  const sent: string[] = [];
  const socket: WebsocketSocket = {
    frames: async function* () {
      for (const frame of frames) yield frame;
    },
    send: async (frame) => {
      sent.push(frame);
    },
    close: vi.fn(async () => {}),
  };
  return { socket, sent };
}

describe("websocketAcknowledgement", () => {
  it("escapes the correlation value into the one marked string position", () => {
    expect(
      websocketAcknowledgement(
        { correlationPointer: "/envelope_id", template: '{"envelope_id":"{correlation}"}' },
        { envelope_id: 'a"b' }
      )
    ).toBe('{"envelope_id":"a\\"b"}');
  });

  it("refuses a frame that carries no correlation value", () => {
    expect(() =>
      websocketAcknowledgement(
        { correlationPointer: "/envelope_id", template: '{"envelope_id":"{correlation}"}' },
        {}
      )
    ).toThrow(WebsocketFrameError);
  });

  it.each(["$'", "$&", "$$", "$`", "a$'$&$$$`b"])(
    "treats a $-bearing correlation value %j as literal text, not a replacement pattern",
    (correlation) => {
      const ack = websocketAcknowledgement(
        { correlationPointer: "/envelope_id", template: '{"envelope_id":"{correlation}"}' },
        { envelope_id: correlation }
      );
      expect(JSON.parse(ack)).toEqual({ envelope_id: correlation });
    }
  );
});

describe("websocketReconnectDelaySeconds", () => {
  it("grows exponentially and is capped at the declared maximum", () => {
    const reconnect = { maxAttempts: 5, initialDelaySeconds: 2, maxDelaySeconds: 10 };
    expect(websocketReconnectDelaySeconds(reconnect, 1)).toBe(2);
    expect(websocketReconnectDelaySeconds(reconnect, 2)).toBe(4);
    expect(websocketReconnectDelaySeconds(reconnect, 3)).toBe(8);
    expect(websocketReconnectDelaySeconds(reconnect, 4)).toBe(10);
  });
});

describe("acceptWebsocketFrame", () => {
  const deps = (state: WebsocketSupervisorStatePort) => ({
    source,
    sessionEvidenceDigest: "d".repeat(64),
    state,
    encryptPayload: async (raw: Buffer) => `enc:${raw.toString("utf8")}`,
    newDeliveryId: () => "delivery-id",
    holderToken: "worker-a",
  });

  it("records a frame in the durable inbox before returning its acknowledgement", async () => {
    const state = new FakeState();
    const order: string[] = [];
    state.recordFrameIfActive.mockImplementation(async (_key, input, fence) => {
      order.push("record");
      state.recorded.push(input);
      state.fences.push(fence);
      return recorded(true);
    });

    const result = await acceptWebsocketFrame(
      deps(state),
      JSON.stringify({ type: "message_created", envelope_id: "env-1" })
    );

    expect(order).toEqual(["record"]);
    expect(result.outcome).toBe("recorded");
    expect(result.acknowledgement).toBe('{"envelope_id":"env-1"}');
    expect(state.fences[0]).toMatchObject({ holderToken: "worker-a" });
    expect(state.recorded[0]).toMatchObject({
      verification: "verified_websocket",
      deduplicationKey: "env-1",
      eventType: "message.created",
    });
  });

  it("reports a replayed frame as a duplicate through the inbox dedup key", async () => {
    const state = new FakeState();
    const frame = JSON.stringify({ type: "message_created", envelope_id: "env-1" });
    await acceptWebsocketFrame(deps(state), frame);
    const second = await acceptWebsocketFrame(deps(state), frame);
    expect(second.outcome).toBe("duplicate");
  });

  it("discards an unmatched frame but still acknowledges it", async () => {
    const state = new FakeState();
    const result = await acceptWebsocketFrame(
      deps(state),
      JSON.stringify({ type: "ignored", envelope_id: "env-9" })
    );
    expect(result.outcome).toBe("discarded");
    expect(result.acknowledgement).toBe('{"envelope_id":"env-9"}');
    expect(state.recordFrameIfActive).not.toHaveBeenCalled();
  });
});

describe("superviseWebsocketConnection", () => {
  const baseDeps = (state: FakeState, socket: WebsocketSocket) => ({
    key: {
      businessId: "business-1",
      connectionId: "connection-1",
      integrationId: "realtime",
      integrationMajorVersion: 1,
    },
    holderToken: "worker-a",
    resolveSource: async () => source,
    openConnection: async () => ({
      url: "wss://provider.test/socket",
      authenticatedEvidenceDigest: "e".repeat(64),
      verifiedIdentity: identity,
    }),
    transport: { open: async (_url: string, _signal: AbortSignal) => socket },
    state,
    encryptPayload: async (raw: Buffer) => `enc:${raw.toString("utf8")}`,
    newDeliveryId: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `delivery-${n}`;
      };
    })(),
    sleep: async () => {},
  });

  it("does not run when it cannot take the single-holder lease", async () => {
    const state = new FakeState();
    state.acquireResult = false;
    const { socket } = socketFrom([]);
    const controller = new AbortController();

    const summary = await superviseWebsocketConnection({
      ...baseDeps(state, socket),
      signal: controller.signal,
    });

    expect(summary).toMatchObject({ acquired: false, stop: "lease_lost" });
    expect(state.recordFrameIfActive).not.toHaveBeenCalled();
  });

  it("records each frame, acknowledges it, and releases the lease on shutdown", async () => {
    const state = new FakeState();
    const { socket, sent } = socketFrom([
      JSON.stringify({ type: "message_created", envelope_id: "env-1" }),
      JSON.stringify({ type: "message_created", envelope_id: "env-2" }),
    ]);
    const controller = new AbortController();
    // The socket ends after two frames; abort so the supervisor stops rather than reconnecting.
    const deps = baseDeps(state, socket);
    const originalOpen = deps.transport.open;
    deps.transport = {
      open: async (url: string, signal: AbortSignal) => {
        const opened = await originalOpen(url, signal);
        return {
          ...opened,
          frames: async function* () {
            for await (const frame of opened.frames()) {
              yield frame;
            }
            controller.abort();
          },
        };
      },
    };

    const summary = await superviseWebsocketConnection({
      ...deps,
      signal: controller.signal,
    });

    expect(summary).toMatchObject({ acquired: true, recorded: 2, stop: "aborted" });
    expect(sent).toEqual(['{"envelope_id":"env-1"}', '{"envelope_id":"env-2"}']);
    expect(state.release).toHaveBeenCalledOnce();
  });

  it("renews the lease while a socket streams and stops promptly when renewal fails", async () => {
    const state = new FakeState();
    // First renewal (before opening) succeeds; the heartbeat renewal then fails.
    state.renew.mockReset();
    state.renew.mockResolvedValueOnce(true).mockResolvedValue(false);
    const { socket, push, sent, isClosed } = controllableSocket();
    const heartbeatWaiters: Array<() => void> = [];
    const controller = new AbortController();

    const running = superviseWebsocketConnection({
      ...baseDeps(state, socket),
      signal: controller.signal,
      renewIntervalSeconds: 5,
      sleep: (_seconds, signal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          const done = () => resolve();
          heartbeatWaiters.push(done);
          signal.addEventListener("abort", done, { once: true });
        }),
    });

    push(JSON.stringify({ type: "message_created", envelope_id: "env-1" }));
    await vi.waitFor(() => expect(state.recordFrameIfActive).toHaveBeenCalledTimes(1));
    // Fire one heartbeat tick; the renewal now fails and must close the still-open socket.
    await vi.waitFor(() => expect(heartbeatWaiters.length).toBeGreaterThan(0));
    heartbeatWaiters.shift()?.();

    const summary = await running;
    expect(summary.stop).toBe("lease_lost");
    expect(summary.recorded).toBe(1);
    expect(isClosed()).toBe(true);
    expect(sent).toEqual(['{"envelope_id":"env-1"}']);
    expect(state.renew.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(state.release).toHaveBeenCalledOnce();
  });

  it("stops after the bounded reconnect budget is exhausted", async () => {
    const state = new FakeState();
    const controller = new AbortController();
    let opens = 0;
    const deps = baseDeps(state, socketFrom([]).socket);
    deps.transport = {
      open: async (_url: string, _signal: AbortSignal) => {
        opens += 1;
        return socketFrom([]).socket;
      },
    };

    const summary = await superviseWebsocketConnection({
      ...deps,
      signal: controller.signal,
    });

    expect(summary.stop).toBe("reconnect_exhausted");
    expect(summary.reconnectAttempts).toBe(ingress.reconnect.maxAttempts);
    // One initial connect plus maxAttempts reconnects.
    expect(opens).toBe(ingress.reconnect.maxAttempts + 1);
    expect(state.release).toHaveBeenCalledOnce();
  });
});
