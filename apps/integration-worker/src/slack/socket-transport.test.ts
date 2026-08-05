import type { IntegrationHttpPort, IntegrationHttpResponse } from "@tulipfarm/integrations";
import { describe, expect, it, vi } from "vitest";
import type { MinimalWebSocket } from "./socket-transport";
import { SlackSocketTransport } from "./socket-transport";

type Listener = (event: { data?: unknown }) => void;

class FakeWebSocket implements MinimalWebSocket {
  sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
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
  await Promise.resolve();
  await Promise.resolve();
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

  it("acks an events_api envelope over the socket and then dispatches it", async () => {
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
    socket?.emit("message", {
      data: JSON.stringify({ envelope_id: "env-1", type: "events_api", payload: { a: 1 } }),
    });
    await flush();

    expect(socket?.sent).toEqual([JSON.stringify({ envelope_id: "env-1" })]);
    expect(onEnvelope).toHaveBeenCalledWith({
      envelope_id: "env-1",
      type: "events_api",
      payload: { a: 1 },
    });
  });

  it("acks and dispatches an interactive envelope the same way", async () => {
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
    socket?.emit("message", {
      data: JSON.stringify({ envelope_id: "env-2", type: "interactive", payload: { b: 2 } }),
    });
    await flush();

    expect(socket?.sent).toEqual([JSON.stringify({ envelope_id: "env-2" })]);
    expect(onEnvelope).toHaveBeenCalledWith({
      envelope_id: "env-2",
      type: "interactive",
      payload: { b: 2 },
    });
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
