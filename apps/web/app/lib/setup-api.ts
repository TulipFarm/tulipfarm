/*
 * Same-origin client for the first-run setup wizard (INST-003). In production the
 * SPA is served by Fastify from the same origin as the API (ARCH-V1-006), so these
 * use relative paths and cookie auth (the wizard's /setup/admin call sets the
 * session cookie). Kept separate from lib/api.ts (the resources client) because the
 * wizard needs CSRF double-submit and has no VITE_API_URL base.
 */

const CSRF_COOKIE = "csrf_token";

// Read a cookie value. The CSRF token cookie is non-httpOnly so the SPA can echo
// it back in the x-csrf-token header (double-submit). `source` is injectable for tests.
export function readCookie(
  name: string,
  source: string = typeof document !== "undefined" ? document.cookie : ""
): string {
  for (const part of source.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return (await res.json()) as T;
}

export interface ApiResult {
  ok: boolean;
  status: number;
  error?: string;
}

export async function apiPost(path: string, body: unknown): Promise<ApiResult> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": readCookie(CSRF_COOKIE),
    },
    body: JSON.stringify(body),
  });
  if (res.ok) return { ok: true, status: res.status };
  let error = `request failed (${res.status})`;
  try {
    const j = (await res.json()) as { error?: string };
    if (j?.error) error = j.error;
  } catch {
    // non-JSON error body
  }
  return { ok: false, status: res.status, error };
}
