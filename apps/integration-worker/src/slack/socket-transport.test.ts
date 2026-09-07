import type { IntegrationHttpPort, IntegrationHttpResponse } from "@tulipfarm/integrations";
import { describe, expect, it, vi } from "vitest";
import type { MinimalWebSocket } from "./socket-transport";
import { SlackSocketTransport } from "./socket-transport";

type Listener = (event: { data?: unknown }) => void;

class FakeWebSocket implements MinimalWebSocket {
  sent: string[] = [];
  closed = false;
  failNextSend = false;
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("socket write failed");
    }
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function http(response: Partial<IntegrationHttpResponse> = {}): IntegrationHttpPort {
  return {
    send: vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      body: { ok: true, url: "wss://wss-primary.slack.com/link" },
      ...response,
    }),
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("SlackSocketTransport", () => {
  it("mints the WSS URL via apps.connections.open using the app token", async () => {
    const httpPort = http();
    const sockets: FakeWebSocket[] = [];
    const transport = new SlackSocketTransport({
      http: httpPort,
      appToken: "xapp-1",
      onEnvelope: vi.fn().mockResolvedValue(undefined),
      openWebSocket: (url) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        expect(url).toBe("wss://wss-primary.slack.com/link");
        return socket;
      },
    });

    await transport.connect(new AbortController().signal);

    expect(httpPort.send).toHaveBeenCalledWith(
      { method: "POST", path: "/apps.connections.open" },
      "xapp-1"
    );
    expect(sockets).toHaveLength(1);
  });

  it("throws when apps.connections.open is refused", async () => {
    const transport = new SlackSocketTransport({
      http: http({ status: 401, body: { ok: false, error: "invalid_auth" } }),
      appToken: "xapp-1",
      onEnvelope: vi.fn(),
      openWebSocket: () => new FakeWebSocket(),
    });

    await expect(transport.connect(new AbortController().signal)).rejects.toThrow(
      /slack_socket_connect_failed/
    );
  });

  it("acks an events_api envelope only after its handler reserves durable work", async () => {
    let socket: FakeWebSocket | undefined;
    let releaseReservation: (() => void) | undefined;
    const reservation = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    const order: string[] = [];
    const onEnvelope = vi.fn(
      async (_envelope: unknown, ack?: () => Promise<void>): Promise<void> => {
        order.push("reserve");
        await reservation;
        order.push("reserved");
        await ack?.();
        order.push("acked");
      }
    );
    const transport = new SlackSocketTransport({
      http: http(),
      appToken: "xapp-1",
      onEnvelope,
      openWebSocket: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });

    await transport.connect(new AbortController().signal);
    socket?.emit("message", {
      data: JSON.stringify({ envelope_id: "env-1", type: "events_api", payload: { a: 1 } }),
    });
    await flush();

    expect(socket?.sent).toEqual([]);
    releaseReservation?.();
    await flush();

    expect(socket?.sent).toEqual([JSON.stringify({ envelope_id: "env-1" })]);
    expect(order).toEqual(["reserve", "reserved", "acked"]);
    expect(onEnvelope).toHaveBeenCalledWith(
      {
        envelope_id: "env-1",
        type: "events_api",
        payload: { a: 1 },
      },
      expect.any(Function)
    );
  });

  it("closes without acknowledgement when durable reservation fails", async () => {
    let socket: FakeWebSocket | undefined;
    const onEnvelope = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const transport = new SlackSocketTransport({
      http: http(),
      appToken: "xapp-1",
      onEnvelope,
      openWebSocket: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });

    await transport.connect(new AbortController().signal);
    socket?.emit("message", {
      data: JSON.stringify({ envelope_id: "env-2", type: "interactive", payload: { b: 2 } }),
    });
    await flush();

    expect(socket?.sent).toEqual([]);
    expect(socket?.closed).toBe(true);
  });

  it("closes without acknowledgement when reservation misses the deadline", async () => {
    const socket = new FakeWebSocket();
    const transport = new SlackSocketTransport({
      http: http(),
      appToken: "xapp-1",
      acknowledgementDeadlineMs: 1,
      onEnvelope: () => new Promise<void>(() => {}),
      openWebSocket: () => socket,
    });

    await transport.connect(new AbortController().signal);
    socket.emit("message", {
      data: JSON.stringify({ envelope_id: "env-timeout", type: "events_api", payload: {} }),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    expect(socket.closed).toBe(true);
    expect(socket.sent).toEqual([]);
  });

  it("retries safely when the durable reservation succeeds but the acknowledgement is lost", async () => {
    const sockets: FakeWebSocket[] = [];
    let reserved = false;
    let downstreamStarts = 0;
    const onEnvelope = vi.fn(async (_envelope: unknown, ack: () => Promise<void>) => {
      if (!reserved) {
        reserved = true;
        downstreamStarts += 1;
      }
      await ack();
    });
    const transport = new SlackSocketTransport({
      http: http(),
      appToken: "xapp-1",
      onEnvelope,
      openWebSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });

    await transport.connect(new AbortController().signal);
    const first = sockets[0];
    if (first === undefined) throw new Error("test setup: missing first socket");
    first.failNextSend = true;
    const data = JSON.stringify({ envelope_id: "env-retry", type: "events_api" });
    first.emit("message", { data });
    await flush();

    expect(first.closed).toBe(true);
    expect(first.sent).toEqual([]);

    await transport.connect(new AbortController().signal);
    const second = sockets[1];
    if (second === undefined) throw new Error("test setup: missing second socket");
    second.emit("message", { data });
    await flush();

    expect(second.sent).toEqual([JSON.stringify({ envelope_id: "env-retry" })]);
    expect(downstreamStarts).toBe(1);
    expect(onEnvelope).toHaveBeenCalledTimes(2);
  });

  it("sends a response payload only for an envelope that accepts one", async () => {
    let socket: FakeWebSocket | undefined;
    const onEnvelope = vi.fn(async (_envelope: unknown, ack: () => Promise<void>) => ack());
    const followUp = vi.fn(async () => {
      expect(socket?.sent).toHaveLength(1);
    });
    const onResponseEnvelope = vi.fn().mockResolvedValue({
      acknowledgement: {
        response_action: "errors",
        errors: { email: "Enter a valid email." },
      },
      followUp,
    });
    const transport = new SlackSocketTransport({
      http: http(),
      appToken: "xapp-1",
      onEnvelope,
      onResponseEnvelope,
      openWebSocket: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });

    await transport.connect(new AbortController().signal);
    socket?.emit("message", {
      data: JSON.stringify({
        envelope_id: "env-response",
        type: "interactive",
        accepts_response_payload: true,
        payload: { type: "view_submission" },
      }),
    });
    await flush();

    expect(socket?.sent).toEqual([
      JSON.stringify({
        envelope_id: "env-response",
        payload: {
          response_action: "errors",
          errors: { email: "Enter a valid email." },
        },
      }),
    ]);
    expect(onResponseEnvelope).toHaveBeenCalledOnce();
    expect(followUp).toHaveBeenCalledOnce();
    expect(onEnvelope).not.toHaveBeenCalled();
  });

  it.each([
    ["interactive", { type: "block_actions" }],
    ["slash_commands", { command: "/tulipfarm" }],
  ])("routes response-capable %s work through ordinary durable dispatch", async (type, payload) => {
    let socket: FakeWebSocket | undefined;
    const onEnvelope = vi.fn(async (_envelope: unknown, ack: () => Promise<void>) => ack());
    const onResponseEnvelope = vi.fn();
    const transport = new SlackSocketTransport({
      http: http(),
      appToken: "xapp-1",
      onEnvelope,
      onResponseEnvelope,
      openWebSocket: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });

    await transport.connect(new AbortController().signal);
    socket?.emit("message", {
      data: JSON.stringify({
        envelope_id: `env-${type}`,
        type,
        accepts_response_payload: true,
        payload,
      }),
    });
    await flush();

    expect(socket?.sent).toEqual([JSON.stringify({ envelope_id: `env-${type}` })]);
    expect(onEnvelope).toHaveBeenCalledOnce();
    expect(onResponseEnvelope).not.toHaveBeenCalled();
  });

  it("closes without acknowledgement when a response handler fails", async () => {
    let socket: FakeWebSocket | undefined;
    const transport = new SlackSocketTransport({
      http: http(),
      appToken: "xapp-1",
      onEnvelope: vi.fn(),
      onResponseEnvelope: vi.fn().mockRejectedValue(new Error("API unavailable")),
      openWebSocket: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });

    await transport.connect(new AbortController().signal);
    socket?.emit("message", {
      data: JSON.stringify({
        envelope_id: "env-response",
        type: "interactive",
        accepts_response_payload: true,
        payload: { type: "view_submission" },
      }),
    });
    await flush();

    expect(socket?.sent).toEqual([]);
    expect(socket?.closed).toBe(true);
  });

  it("keeps the acknowledgement when post-ack Surface dispatch fails", async () => {
    let socket: FakeWebSocket | undefined;
    const transport = new SlackSocketTransport({
      http: http(),
      appToken: "xapp-1",
      onEnvelope: vi.fn(),
      onResponseEnvelope: vi.fn().mockResolvedValue({
        acknowledgement: {},
        followUp: vi.fn().mockRejectedValue(new Error("API unavailable")),
      }),
      openWebSocket: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });

    await transport.connect(new AbortController().signal);
    socket?.emit("message", {
      data: JSON.stringify({
        envelope_id: "env-response",
        type: "interactive",
        accepts_response_payload: true,
        payload: { type: "view_submission" },
      }),
    });
    await flush();

    expect(socket?.sent).toEqual([JSON.stringify({ envelope_id: "env-response", payload: {} })]);
    expect(socket?.closed).toBe(false);
  });

  it("keeps the empty acknowledgement path when response payloads are not accepted", async () => {
    let socket: FakeWebSocket | undefined;
    const onEnvelope = vi.fn(async (_envelope: unknown, ack: () => Promise<void>) => ack());
    const onResponseEnvelope = vi.fn().mockResolvedValue({ acknowledgement: { ignored: true } });
    const transport = new SlackSocketTransport({
      http: http(),
      appToken: "xapp-1",
      onEnvelope,
      onResponseEnvelope,
      openWebSocket: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });

    await transport.connect(new AbortController().signal);
    socket?.emit("message", {
      data: JSON.stringify({
        envelope_id: "env-empty",
        type: "events_api",
        accepts_response_payload: false,
        payload: { a: 1 },
      }),
    });
    await flush();

    expect(socket?.sent).toEqual([JSON.stringify({ envelope_id: "env-empty" })]);
    expect(onEnvelope).toHaveBeenCalledOnce();
    expect(onResponseEnvelope).not.toHaveBeenCalled();
  });

  it("ignores hello and never acks or dispatches it", async () => {
    let socket: FakeWebSocket | undefined;
    const onEnvelope = vi.fn().mockResolvedValue(undefined);
    const transport = new SlackSocketTransport({
      http: http(),
      appToken: "xapp-1",
      onEnvelope,
      openWebSocket: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });

    await transport.connect(new AbortController().signal);
    socket?.emit("message", { data: JSON.stringify({ envelope_id: "env-3", type: "hello" }) });
    await flush();

    expect(socket?.sent).toEqual([]);
    expect(onEnvelope).not.toHaveBeenCalled();
  });

  it("closes the socket on a disconnect envelope, resolving `closed`", async () => {
    let socket: FakeWebSocket | undefined;
    const transport = new SlackSocketTransport({
      http: http(),
      appToken: "xapp-1",
      onEnvelope: vi.fn().mockResolvedValue(undefined),
      openWebSocket: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });

    const connection = await transport.connect(new AbortController().signal);
    socket?.emit("message", {
      data: JSON.stringify({ envelope_id: "env-4", type: "disconnect", reason: "refresh" }),
    });
    await flush();

    await connection.closed;
    expect(socket?.closed).toBe(true);
  });

  it("closes the socket when the transport's signal is aborted", async () => {
    let socket: FakeWebSocket | undefined;
    const controller = new AbortController();
    const transport = new SlackSocketTransport({
      http: http(),
      appToken: "xapp-1",
      onEnvelope: vi.fn().mockResolvedValue(undefined),
      openWebSocket: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });

    const connection = await transport.connect(controller.signal);
    controller.abort();
    await connection.closed;

    expect(socket?.closed).toBe(true);
  });
});
