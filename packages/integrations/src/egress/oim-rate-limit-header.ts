import { MAX_PROVIDER_RETRY_DELAY_MS } from "@tulipfarm/tool-broker";

export const OIM_MAX_RETRY_AFTER_MS = MAX_PROVIDER_RETRY_DELAY_MS;

function headerValue(
  headers: Readonly<Record<string, string>>,
  headerName: string
): string | undefined {
  const wanted = headerName.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === wanted) return value.trim();
  }
  return undefined;
}

/** Parses RFC Retry-After delay-seconds or HTTP-date and clamps it to the host's durable-wait cap. */
export function parseOimRetryAfterMs(
  headers: Readonly<Record<string, string>>,
  now: Date,
  headerName = "Retry-After"
): number | undefined {
  const value = headerValue(headers, headerName);
  if (value === undefined || value.length === 0) return undefined;
  if (/^(0|[1-9][0-9]*)$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return undefined;
    return Math.min(seconds * 1000, OIM_MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at <= now.getTime()) return undefined;
  return Math.min(at - now.getTime(), OIM_MAX_RETRY_AFTER_MS);
}
