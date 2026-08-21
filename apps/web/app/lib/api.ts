/* Cookie-first resource API client; non-2xx responses throw `ApiError` with status. */

import { randomUUID } from "./uuid";

export const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4010";

export class ApiError extends Error {
  readonly status: number;
  // JSON Pointer to the offending field on a 422 (`{path}` from the API), so forms can map a
  // validation failure back onto the input that caused it. Undefined for non-validation errors.
  readonly path?: string;

  constructor(status: number, message: string, path?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
  }
}

export type ResourceTypeSummary = {
  name: string;
  // A YAML string of a JSON Schema; parse with `parseSchema` in lib/schema.ts.
  schema: string;
  hasHooks: boolean;
};

export type ResourceRecord = {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
} & Record<string, unknown>;

export type RecordPage = {
  items: ResourceRecord[];
  nextCursor: string | null;
};

export async function apiGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  applyAuth(headers);

  const res = await fetch(`${API_BASE}${path}`, { credentials: "include", headers });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

// Write client (POST/PUT). Mirrors apiGet's cookie-first auth, adds a JSON body, the optional
// `If-Match` concurrency header, and the CSRF echo header (no-op when authed by Bearer token).
export async function apiWrite<T>(
  method: "POST" | "PUT" | "PATCH",
  path: string,
  body: unknown,
  ifMatch?: number
): Promise<T> {
  const headers = mutationHeaders();
  if (ifMatch !== undefined) headers["If-Match"] = `"${ifMatch}"`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

/** A retry-safe server command. The server remains authoritative and deduplicates by this key. */
export async function apiCommand<T>(
  path: string,
  body: unknown,
  idempotencyKey: string
): Promise<T> {
  const headers = mutationHeaders();
  headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

// Like apiWrite (cookie-first auth, CSRF echo, optional If-Match) but for endpoints that return
// 204 No Content — sends a JSON body and parses nothing, so it returns void.
export async function apiSend(
  method: "POST" | "PUT",
  path: string,
  body: unknown,
  ifMatch?: number
): Promise<void> {
  const headers = mutationHeaders();
  if (ifMatch !== undefined) headers["If-Match"] = `"${ifMatch}"`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
}

// DELETE client. Mirrors apiWrite's cookie-first auth + CSRF echo, but sends no body and expects an
// empty (204) response, so it returns void instead of parsing JSON. `ifMatch` (the record version)
// is sent as the optimistic-concurrency header for endpoints that require it (resource records).
export async function apiDelete(path: string, ifMatch?: number): Promise<void> {
  const headers: Record<string, string> = { Accept: "application/json" };
  applyAuth(headers);
  const csrf = readCookie(CSRF_COOKIE);
  if (csrf) headers["x-csrf-token"] = csrf;
  if (ifMatch !== undefined) headers["If-Match"] = `"${ifMatch}"`;

  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    credentials: "include",
    headers,
  });
  if (!res.ok) throw await readError(res);
}

const CSRF_COOKIE = "csrf_token";

// Headers shared by JSON-body mutations (apiWrite's POST/PUT and the chat stream POST): JSON Accept
// + Content-Type, cookie-first auth, and the CSRF echo header (a no-op when authed by Bearer
// token). Callers add request-specific headers (e.g. `If-Match`) onto the returned object.
export function mutationHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  applyAuth(headers);
  const csrf = readCookie(CSRF_COOKIE);
  if (csrf) headers["x-csrf-token"] = csrf;
  return headers;
}

function applyAuth(headers: Record<string, string>): void {
  const token = import.meta.env.VITE_API_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
}

// Reads a non-httpOnly cookie by name (the API sets `csrf_token` with httpOnly:false for this).
function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

// Best-effort extraction of the API's `{ error, path }` body into an ApiError; falls back to
// status text. `path` (present on 422) lets forms highlight the offending field. Exported so clients
// that bypass the JSON helpers (binary export, raw-zip import) can reuse the same error mapping.
export async function readError(res: Response): Promise<ApiError> {
  let message = res.statusText || `request failed (${res.status})`;
  let path: string | undefined;
  try {
    const body = (await res.json()) as {
      error?: unknown;
      path?: unknown;
    };
    if (typeof body.error === "string") message = body.error;
    if (
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
    ) {
      message = body.error.message;
    }
    if (typeof body.path === "string" && body.path.length > 0) path = body.path;
  } catch {
    // non-JSON body — keep the status-text fallback
  }
  return new ApiError(res.status, message, path);
}

// `invited` is an account that exists but has no password yet: it holds an outstanding invite link
// and cannot authenticate until that link is redeemed.
export type UserStatus = "active" | "invited" | "disabled";

export type SessionUser = {
  id: string;
  email: string;
  // Null until the person sets one. Never derived from the email — a guess that looks authored is
  // worse than an honest absence.
  name: string | null;
  role: string;
  status: UserStatus;
  createdAt?: string;
  /**
   * Whether the API considers this person an admin of the business, decided by the same gate the
   * admin routes are behind rather than by `role`, which a granted access level never rewrites.
   */
  isAdmin?: boolean;
};

// Establish a session: POST credentials to the API, which sets the httpOnly session cookie + the
// CSRF cookie. A 401 throws ApiError("invalid credentials"); the form surfaces err.message.
export async function login(email: string, password: string): Promise<SessionUser> {
  return (await postPreSession<{ user: SessionUser }>("/api/v1/auth/login", { email, password }))
    .user;
}

// Current authenticated user (cookie session or dev Bearer token). Throws ApiError(401) when
// unauthenticated — the _app gate uses that to redirect to /login.
export async function getSession(): Promise<SessionUser> {
  return (await apiGet<{ user: SessionUser }>("/api/v1/auth/session")).user;
}

// Update the current user's own profile. Self-service and scoped to the caller's own record by the
// server; there is no user id in the path precisely so it cannot be aimed at anyone else.
export async function updateProfile(name: string | null): Promise<SessionUser> {
  return (await apiWrite<{ user: SessionUser }>("PATCH", "/api/v1/auth/profile", { name })).user;
}

// Change the current user's password. The current one is required — a stolen session must not be
// able to lock the owner out. Rotates the session, so the caller stays signed in on the new one.
export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<SessionUser> {
  return (
    await apiWrite<{ user: SessionUser }>("POST", "/api/v1/auth/change-password", {
      currentPassword,
      newPassword,
    })
  ).user;
}

// Login, invite preview, and invite accept all authenticate a caller who has no session yet, so
// they skip the CSRF echo `apiWrite` adds: there is no session-bound token to send, and the API
// exempts these paths for that reason (see `auth/csrf.ts`). Bodies carry the credential, so a
// token never reaches a query string.
async function postPreSession<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

// Resolves an invite link to the account it will set a password for, without spending it.
export async function previewInvite(token: string): Promise<{ email: string; expiresAt: string }> {
  return postPreSession("/api/v1/auth/invites/preview", { token });
}

// Redeems an invite link: sets the password, activates the account, and signs in.
export async function acceptInvite(token: string, password: string): Promise<SessionUser> {
  return (
    await postPreSession<{ user: SessionUser }>("/api/v1/auth/invites/accept", {
      token,
      password,
    })
  ).user;
}

// Destroy the session + clear the cookie. Best-effort: ignores the response (logout is idempotent).
export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/api/v1/auth/logout`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(),
  });
}

// Create a resource type. `schema` is a JSON Schema serialised as a string (JSON is valid YAML, so
// the API's YAML parser accepts it). Returns the persisted summary; 409 if the type already exists.
export async function createResourceType(
  name: string,
  schema: string
): Promise<ResourceTypeSummary> {
  return apiWrite<ResourceTypeSummary>("POST", "/api/v1/resource-types", { name, schema });
}

// Replace a resource type's schema (full schema string, JSON or YAML). 404 if the type is gone.
export async function updateResourceType(
  name: string,
  schema: string
): Promise<ResourceTypeSummary> {
  return apiWrite<ResourceTypeSummary>(
    "PUT",
    `/api/v1/resource-types/${encodeURIComponent(name)}`,
    { schema }
  );
}

// Remove a resource type's definition from the soul. Non-destructive: the Postgres table (records)
// is left intact. Returns 204 (void).
export async function deleteResourceType(name: string): Promise<void> {
  return apiDelete(`/api/v1/resource-types/${encodeURIComponent(name)}`);
}

export async function listResourceTypes(): Promise<ResourceTypeSummary[]> {
  const body = await apiGet<{ types: ResourceTypeSummary[] }>("/api/v1/resource-types");
  return body.types;
}

export async function listRecords(
  type: string,
  cursor?: string,
  limit = 50,
  includeDeleted = false
): Promise<RecordPage> {
  const query = new URLSearchParams({
    limit: String(limit),
    includeDeleted: String(includeDeleted),
  });
  if (cursor) query.set("cursor", cursor);
  return apiGet<RecordPage>(`/api/v1/resources/${encodeURIComponent(type)}?${query.toString()}`);
}

export async function getRecord(type: string, id: string): Promise<ResourceRecord> {
  return apiGet<ResourceRecord>(
    `/api/v1/resources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
  );
}

// Create a record. Returns the persisted record (201 body) including the server-assigned id/version.
export async function createRecord(
  type: string,
  body: Record<string, unknown>,
  idempotencyKey = randomUUID()
): Promise<ResourceRecord> {
  return apiCommand<ResourceRecord>(
    `/api/v1/resources/${encodeURIComponent(type)}`,
    body,
    idempotencyKey
  );
}

// Full-replace update with optimistic concurrency. `version` is sent as the `If-Match` header; a
// stale version yields ApiError(409). Returns the updated record (new version).
export async function updateRecord(
  type: string,
  id: string,
  version: number,
  body: Record<string, unknown>
): Promise<ResourceRecord> {
  return apiWrite<ResourceRecord>(
    "PUT",
    `/api/v1/resources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    body,
    version
  );
}

// Soft-delete a record with optimistic concurrency. `version` is sent as `If-Match`; a stale version
// yields ApiError(409). The API soft-deletes (history preserved); returns 204 (void).
export async function deleteRecord(type: string, id: string, version: number): Promise<void> {
  return apiDelete(
    `/api/v1/resources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    version
  );
}
