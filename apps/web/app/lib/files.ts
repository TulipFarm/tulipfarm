/**
 * Uploading a File from the browser.
 *
 * `XMLHttpRequest` rather than `fetch`, for one reason: upload progress. `fetch` reports nothing
 * about how much of a request body has been sent, so a person watching a 20 MB screenshot upload
 * would see a spinner and no movement. `XMLHttpRequest.upload` is still the only browser API that
 * reports it.
 *
 * The body is the object itself and the claimed type is the request's `Content-Type`. There is no
 * multipart envelope, because the server checks the declared length before reading a byte and a
 * multipart part header would have to be parsed first.
 */

import { API_BASE, mutationHeaders } from "./api";

export const fileContentUrl = (fileId: string) =>
  `${API_BASE}/api/v1/files/${encodeURIComponent(fileId)}/content`;

export interface UploadedFile {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export interface UploadHandle {
  readonly done: Promise<UploadedFile>;
  /** Aborts the request. `done` rejects with an `UploadCancelled`. */
  cancel(): void;
}

export class UploadCancelled extends Error {
  constructor() {
    super("upload cancelled");
    this.name = "UploadCancelled";
  }
}

export class UploadFailed extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "UploadFailed";
  }
}

function messageFor(status: number, raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // A non-JSON body means the failure came from somewhere above the route.
  }
  if (status === 413) return "That file is too large.";
  if (status === 415) return "That file type is not supported.";
  return "The upload failed.";
}

export function uploadFile(file: File, onProgress?: (fraction: number) => void): UploadHandle {
  const request = new XMLHttpRequest();
  const url = `${API_BASE}/api/v1/files?filename=${encodeURIComponent(file.name)}`;

  const done = new Promise<UploadedFile>((resolve, reject) => {
    request.open("POST", url, true);
    request.withCredentials = true;
    // The same auth and CSRF headers every other mutation sends, with the JSON content type
    // replaced: an empty `file.type` is what a browser reports for a format it does not know, and
    // the server sniffs the bytes regardless, so this claim only has to be honest.
    for (const [name, value] of Object.entries(mutationHeaders())) {
      // Skipped rather than overwritten: `setRequestHeader` appends to an existing name, so
      // setting it twice would send `application/json, image/png`.
      if (name.toLowerCase() === "content-type") continue;
      request.setRequestHeader(name, value);
    }
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    });
    request.addEventListener("abort", () => reject(new UploadCancelled()));
    request.addEventListener("error", () => reject(new UploadFailed(0, "The upload failed.")));
    request.addEventListener("load", () => {
      if (request.status === 201) {
        resolve(JSON.parse(request.responseText) as UploadedFile);
        return;
      }
      reject(new UploadFailed(request.status, messageFor(request.status, request.responseText)));
    });

    request.send(file);
  });

  return { done, cancel: () => request.abort() };
}

/**
 * The bytes of a File, as an object URL.
 *
 * Not an `<img src>` pointing at the route: the API is cookie-first with an optional bearer token,
 * and a subresource request carries neither across origins — a `SameSite=Lax` cookie is not sent on
 * a cross-origin image load, and an `<img>` cannot carry an `Authorization` header at all. Fetching
 * it as an authenticated request and handing the browser a blob works in both deployments.
 *
 * The caller must revoke the returned URL; `URL.createObjectURL` leaks until it does.
 */
export async function fetchFileObjectUrl(fileId: string, signal?: AbortSignal): Promise<string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(mutationHeaders())) {
    // Only the auth and CSRF entries apply to a read; the JSON types would be a lie about the body.
    if (name === "Accept" || name === "Content-Type") continue;
    headers[name] = value;
  }
  const response = await fetch(fileContentUrl(fileId), {
    credentials: "include",
    headers,
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new UploadFailed(response.status, "That file could not be loaded.");
  return URL.createObjectURL(await response.blob());
}

/**
 * The input modalities some configured model accepts.
 *
 * Advisory: the server performs the authoritative check when the turn routes. This exists so the
 * composer can refuse a file nobody could read *before* a prompt is written around it. It answers
 * with the union across configured models, so only an absent modality is worth acting on.
 */
export async function fetchAcceptedModalities(signal?: AbortSignal): Promise<readonly string[]> {
  const response = await fetch(`${API_BASE}/api/v1/files/accepted-modalities`, {
    credentials: "include",
    signal,
  });
  if (!response.ok) throw new Error("could not read the accepted modalities");
  const body = (await response.json()) as { acceptedInputModalities?: readonly string[] };
  return body.acceptedInputModalities ?? [];
}

/** A File as the library lists it: everything a row can show without fetching its bytes. */
export interface LibraryFile extends UploadedFile {
  readonly owner: string;
  readonly origin: "uploaded" | "generated";
  readonly sourceChatId: string | null;
  /** How many grants this File carries. `null` when the caller does not own it, never 0. */
  readonly sharedWithCount: number | null;
}

export interface FilePage {
  readonly files: readonly LibraryFile[];
  /** `null` once the last page has been read. */
  readonly nextCursor: string | null;
}

/**
 * One page of the caller's own Files, newest first.
 *
 * Cursor rather than page number: someone uploading while the library is open shifts every later
 * row, and an offset would show one File twice and hide another entirely.
 */
export async function fetchFiles(
  options: { limit?: number; after?: string | null; signal?: AbortSignal } = {}
): Promise<FilePage> {
  return await fetchFilePage("/api/v1/files", "Your files could not be loaded.", options);
}

/**
 * One page of the Files someone else has shared with the caller.
 *
 * Separate from `fetchFiles` rather than a filter on it, because they are different questions:
 * what a person owns is durable, and what reaches them through a share can end at any moment
 * without them acting.
 */
export async function fetchSharedWithMe(
  options: { limit?: number; after?: string | null; signal?: AbortSignal } = {}
): Promise<FilePage> {
  return await fetchFilePage(
    "/api/v1/files/shared-with-me",
    "Files shared with you could not be loaded.",
    options
  );
}

async function fetchFilePage(
  path: string,
  failure: string,
  options: { limit?: number; after?: string | null; signal?: AbortSignal }
): Promise<FilePage> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
  if (options.after) query.set("after", options.after);

  const response = await fetch(`${API_BASE}${path}?${query}`, {
    credentials: "include",
    headers: readHeaders(),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new UploadFailed(response.status, failure);
  const body = (await response.json()) as { files?: LibraryFile[]; nextCursor?: string | null };
  return { files: body.files ?? [], nextCursor: body.nextCursor ?? null };
}

/** A share target: one person, or everyone holding one Role. */
export interface FileGrantee {
  readonly kind: "user" | "role";
  readonly id: string;
}

export interface FileShare extends FileGrantee {
  readonly sharedBy: string;
  readonly sharedAt: string;
}

/** Who a File is shared with. Only its owner may ask; anyone else gets the missing-File answer. */
export async function fetchFileShares(
  fileId: string,
  signal?: AbortSignal
): Promise<readonly FileShare[]> {
  const response = await fetch(`${API_BASE}/api/v1/files/${encodeURIComponent(fileId)}/shares`, {
    credentials: "include",
    headers: readHeaders(),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new UploadFailed(response.status, "Sharing could not be loaded.");
  return ((await response.json()) as { shares?: FileShare[] }).shares ?? [];
}

export async function shareFile(fileId: string, grantee: FileGrantee): Promise<void> {
  const response = await fetch(`${API_BASE}/api/v1/files/${encodeURIComponent(fileId)}/shares`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(),
    body: JSON.stringify(grantee),
  });
  if (!response.ok) throw new UploadFailed(response.status, "That file could not be shared.");
}

export async function unshareFile(fileId: string, grantee: FileGrantee): Promise<void> {
  const response = await fetch(
    `${API_BASE}/api/v1/files/${encodeURIComponent(fileId)}/shares/${grantee.kind}/${encodeURIComponent(grantee.id)}`,
    { method: "DELETE", credentials: "include", headers: mutationHeaders() }
  );
  if (!response.ok) throw new UploadFailed(response.status, "That share could not be revoked.");
}

/** `mutationHeaders` without `Content-Type`, which a GET has no body to describe. */
function readHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(mutationHeaders())) {
    if (name === "Content-Type") continue;
    headers[name] = value;
  }
  return headers;
}

/** A size a person can read. Binary units, because that is what the byte limits are stated in. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** One File's metadata. Answers 404 for a File the caller does not own, same as a missing one. */
export async function fetchFile(fileId: string, signal?: AbortSignal): Promise<UploadedFile> {
  const response = await fetch(`${API_BASE}/api/v1/files/${encodeURIComponent(fileId)}`, {
    credentials: "include",
    headers: readHeaders(),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new UploadFailed(response.status, "That file could not be found.");
  return (await response.json()) as UploadedFile;
}
