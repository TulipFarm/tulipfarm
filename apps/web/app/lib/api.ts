/*
 * Read-only client for the resource API. React/Remix-free so it is unit-testable by mocking the
 * global `fetch`. Auth is cookie-first (`credentials: "include"`) with an optional dev bearer token
 * from `VITE_API_TOKEN`. Every non-2xx response throws an `ApiError` carrying the HTTP status so
 * routes can branch on 401 (auth) vs 404 (not found).
 */

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4010";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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

async function apiGet<T>(path: string): Promise<T> {
  const token = import.meta.env.VITE_API_TOKEN;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { credentials: "include", headers });
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as T;
}

// Best-effort extraction of the API's `{ error }` body; falls back to the status text.
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // non-JSON body — fall through to status text
  }
  return res.statusText || `request failed (${res.status})`;
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
