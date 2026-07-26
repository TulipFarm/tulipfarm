export interface SlackReconnectOptions {
  baseMs?: number;
  maxMs?: number;
  jitter?: () => number;
}

/** Exponential reconnect delay with ±50% jitter, capped before and after jitter. */
export function slackReconnectDelay(attempt: number, options: SlackReconnectOptions = {}): number {
  const baseMs = options.baseMs ?? 1000;
  const maxMs = options.maxMs ?? 30_000;
  const jitter = Math.min(1, Math.max(0, (options.jitter ?? Math.random)()));
  const nominal = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.min(maxMs, Math.round(nominal * (0.5 + jitter * 0.5)));
}

export interface SlackSocketConnection {
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface SlackSocketTransport {
  connect(signal: AbortSignal): Promise<SlackSocketConnection>;
}

export interface SlackSocketWorkerOptions extends SlackReconnectOptions {
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

function defaultWait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/** Socket Mode lifecycle owner. Message handling is injected by the concrete transport. */
export class SlackSocketWorker {
  constructor(
    private readonly transport: SlackSocketTransport,
    private readonly options: SlackSocketWorkerOptions = {}
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      let connection: SlackSocketConnection | undefined;
      try {
        connection = await this.transport.connect(signal);
        attempt = 0;
        await connection.closed;
      } catch {
        attempt += 1;
      } finally {
        await connection?.close();
      }
      if (signal.aborted) return;
      const delay = slackReconnectDelay(attempt, this.options);
      await (this.options.wait ?? defaultWait)(delay, signal);
    }
  }
}
