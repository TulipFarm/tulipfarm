import type { IntegrationHttpPort } from "@tulipfarm/integrations";
import type { SlackSocketConnection } from "./worker";

/** One decoded Socket Mode envelope, before this app decides what it means. */
export interface SlackSocketEnvelope {
  envelope_id: string;
  type: string;
  payload?: unknown;
  reason?: string;
  accepts_response_payload?: boolean;
}

function isSlackSocketEnvelope(value: unknown): value is SlackSocketEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.envelope_id === "string" && typeof record.type === "string";
}

/** The subset of the WHATWG `WebSocket` this transport uses — narrowed so tests can fake it. */
export interface MinimalWebSocket {
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void
  ): void;
  send(data: string): void;
  close(): void;
}

export interface SlackSocketTransportOptions {
  /** Slack Web API transport, used only to mint the WSS URL via `apps.connections.open`. */
  http: IntegrationHttpPort;
  /** `xapp-...` app-level token (`connections:write` scope). */
  appToken: string;
  /** Called once per decoded envelope, after this transport has already acked it. */
  onEnvelope: (envelope: SlackSocketEnvelope) => Promise<void>;
  openWebSocket?: (url: string) => MinimalWebSocket;
  /** Injected in tests so acks aren't asserted against real time. */
  log?: { warn: (message: string, error?: unknown) => void };
}

interface ConnectionsOpenResponse {
  ok?: unknown;
  url?: unknown;
  error?: unknown;
}

function defaultOpenWebSocket(url: string): MinimalWebSocket {
  return new WebSocket(url) as unknown as MinimalWebSocket;
}

/** Acks each Slack envelope before downstream work so slow Run starts cannot miss the window. */
export class SlackSocketTransport {
  constructor(private readonly options: SlackSocketTransportOptions) {}

  async connect(signal: AbortSignal): Promise<SlackSocketConnection> {
    const opened = await this.options.http.send(
      { method: "POST", path: "/apps.connections.open" },
      this.options.appToken
    );
    const body = opened.body as ConnectionsOpenResponse | undefined;
    if (opened.status !== 200 || body?.ok !== true || typeof body.url !== "string") {
      throw new Error(
        `slack_socket_connect_failed:${typeof body?.error === "string" ? body.error : opened.status}`
      );
    }

    const socket = (this.options.openWebSocket ?? defaultOpenWebSocket)(body.url);

    let resolveClosed: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const onAbort = () => {
      socket.close();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    socket.addEventListener("message", (event) => {
      this.handleMessage(socket, event.data).catch((error: unknown) => {
        this.options.log?.warn("slack socket message handling failed", error);
      });
    });
    socket.addEventListener("close", () => {
      signal.removeEventListener("abort", onAbort);
      resolveClosed();
    });
    socket.addEventListener("error", () => {
      socket.close();
    });

    return {
      closed,
      close: async () => {
        socket.close();
      },
    };
  }

  private async handleMessage(socket: MinimalWebSocket, data: unknown): Promise<void> {
    if (typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isSlackSocketEnvelope(parsed)) return;
    if (parsed.type === "hello") return;
    if (parsed.type === "disconnect") {
      socket.close();
      return;
    }

    socket.send(JSON.stringify({ envelope_id: parsed.envelope_id }));
    await this.options.onEnvelope(parsed);
  }
}
