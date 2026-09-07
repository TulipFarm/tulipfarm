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

export interface SlackResponseEnvelopeResult {
  readonly acknowledgement: unknown;
  readonly followUp?: () => Promise<void>;
}

function isSlackSocketEnvelope(value: unknown): value is SlackSocketEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.envelope_id === "string" && typeof record.type === "string";
}

function requiresResponsePayload(envelope: SlackSocketEnvelope): boolean {
  if (envelope.accepts_response_payload !== true || envelope.type !== "interactive") return false;
  if (
    envelope.payload === null ||
    typeof envelope.payload !== "object" ||
    Array.isArray(envelope.payload)
  ) {
    return false;
  }
  const type = (envelope.payload as Record<string, unknown>).type;
  return type === "block_suggestion" || type === "view_submission";
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
  /** Reserves durable work, acknowledges through the callback, then performs bounded follow-up. */
  onEnvelope: (envelope: SlackSocketEnvelope, ack: () => Promise<void>) => Promise<void>;
  /**
   * Reserves envelope families whose acknowledgement includes a response payload.
   * Reservation is deadline-bounded; returned follow-up runs only after the Socket write.
   */
  onResponseEnvelope?: (envelope: SlackSocketEnvelope) => Promise<SlackResponseEnvelopeResult>;
  openWebSocket?: (url: string) => MinimalWebSocket;
  acknowledgementDeadlineMs?: number;
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

/** Lets handlers commit durable work before acknowledgement and closes on pre-ack failure. */
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

    let acknowledged = false;
    let acknowledgementAllowed = true;
    let signalAcknowledged: () => void = () => {};
    const acknowledgement = new Promise<void>((resolve) => {
      signalAcknowledged = resolve;
    });
    const deadlineMs = this.options.acknowledgementDeadlineMs ?? 2_500;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error("slack_acknowledgement_deadline_exceeded")),
        deadlineMs
      );
    });
    const sendAcknowledgement = async (payload?: unknown): Promise<void> => {
      if (acknowledged) return;
      if (!acknowledgementAllowed) {
        throw new Error("slack_acknowledgement_deadline_exceeded");
      }
      socket.send(
        JSON.stringify({
          envelope_id: parsed.envelope_id,
          ...(payload === undefined ? {} : { payload }),
        })
      );
      acknowledged = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      signalAcknowledged();
    };

    try {
      if (requiresResponsePayload(parsed) && this.options.onResponseEnvelope !== undefined) {
        const response = await Promise.race([this.options.onResponseEnvelope(parsed), deadline]);
        await sendAcknowledgement(response.acknowledgement);
        await response.followUp?.();
        return;
      }

      const work = this.options.onEnvelope(parsed, () => sendAcknowledgement());
      const first = await Promise.race([
        work.then(() => "finished" as const),
        acknowledgement.then(() => "acknowledged" as const),
        deadline,
      ]);
      if (first === "finished" && !acknowledged) {
        throw new Error("slack_envelope_returned_without_acknowledgement");
      }
      await work;
    } catch (error) {
      acknowledgementAllowed = false;
      if (!acknowledged) socket.close();
      throw error;
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
  }
}
