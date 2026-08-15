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
