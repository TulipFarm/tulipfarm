export interface TelegramReconnectOptions {
  baseMs?: number;
  maxMs?: number;
  jitter?: () => number;
}

export function telegramReconnectDelay(
  attempt: number,
  options: TelegramReconnectOptions = {}
): number {
  const baseMs = options.baseMs ?? 1000;
  const maxMs = options.maxMs ?? 30_000;
  const jitter = Math.min(1, Math.max(0, (options.jitter ?? Math.random)()));
  const nominal = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.min(maxMs, Math.round(nominal * (0.5 + jitter * 0.5)));
}

export interface TelegramUpdateStream {
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface TelegramUpdateTransport {
  connect(signal: AbortSignal): Promise<TelegramUpdateStream>;
}

export interface TelegramUpdateWorkerOptions extends TelegramReconnectOptions {
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

/** Long-poll/webhook stream lifecycle owner; concrete update handling stays injected. */
export class TelegramUpdateWorker {
  constructor(
    private readonly transport: TelegramUpdateTransport,
    private readonly options: TelegramUpdateWorkerOptions = {}
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      let stream: TelegramUpdateStream | undefined;
      try {
        stream = await this.transport.connect(signal);
        attempt = 0;
        await stream.closed;
      } catch {
        attempt += 1;
      } finally {
        await stream?.close();
      }
      if (signal.aborted) return;
      await (this.options.wait ?? defaultWait)(
        telegramReconnectDelay(attempt, this.options),
        signal
      );
    }
  }
}
