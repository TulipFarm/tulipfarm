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

import { uploadMediaType } from "@tulipfarm/files/limits";
import { API_BASE, mutationHeaders } from "./api";

export const fileContentUrl = (fileId: string) =>
  `${API_BASE}/api/v1/files/${encodeURIComponent(fileId)}/content`;

export const fileDraftContentUrl = (draftId: string) =>
  `${API_BASE}/api/v1/file-drafts/${encodeURIComponent(draftId)}/content`;

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

/**
 * A friendly message for a failed upload, keyed on HTTP status only.
 *
 * The server's `error` body is never shown verbatim: it is an internal code meant for logs, not
 * prose meant for a chat chip, and surfacing it raw leaked implementation detail (and, for a 403,
 * a confusing permission code) straight into the UI. Every status maps to a fixed sentence.
 */
function messageFor(status: number): string {
  if (status === 401) return "Your session expired — sign in again.";
  if (status === 403) return "You don't have permission to upload files.";
  if (status === 413) return "That file is too large.";
  if (status === 415) return "That file type is not supported.";
  return "The upload failed. Try again.";
}

export function uploadFile(
  file: File,
  onProgress?: (fraction: number) => void,
  filename = file.name,
  folderId?: string
): UploadHandle {
  const request = new XMLHttpRequest();
  const query = new URLSearchParams({ filename });
  if (folderId) query.set("folderId", folderId);
  const url = `${API_BASE}/api/v1/files?${query}`;

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
    request.setRequestHeader(
      "Content-Type",
      (uploadMediaType(file.type, file.name) ?? file.type) || "application/octet-stream"
    );

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
      reject(new UploadFailed(request.status, messageFor(request.status)));
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
  return await fetchAuthenticatedObjectUrl(fileContentUrl(fileId), signal);
}

export async function fetchFileDraftObjectUrl(
  draftId: string,
  signal?: AbortSignal
): Promise<string> {
  return await fetchAuthenticatedObjectUrl(fileDraftContentUrl(draftId), signal);
}

/**
 * A File's raw bytes, for a viewer that has to read inside the file rather than hand it to the
 * browser — an Office package, whose parts only become text after the ZIP is opened.
 */
export async function fetchFileBytes(
  fileId: string,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array; text: () => string }> {
  const response = await fetch(fileContentUrl(fileId), {
    credentials: "include",
    headers: authenticatedReadHeaders(),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new UploadFailed(response.status, "That file could not be loaded.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, text: () => new TextDecoder().decode(bytes) };
}

export async function fetchFileDraftText(draftId: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(fileDraftContentUrl(draftId), {
    credentials: "include",
    headers: authenticatedReadHeaders(),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new UploadFailed(response.status, "That draft could not be loaded.");
  return await response.text();
}

async function fetchAuthenticatedObjectUrl(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    credentials: "include",
    headers: authenticatedReadHeaders(),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new UploadFailed(response.status, "That file could not be loaded.");
  return URL.createObjectURL(await response.blob());
}

function authenticatedReadHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(mutationHeaders())) {
    // Only auth applies to a read; JSON content headers would be a lie about an empty body.
    if (name === "Accept" || name === "Content-Type") continue;
    headers[name] = value;
  }
  return headers;
}

export async function saveFileDraft(draftId: string): Promise<LibraryFile> {
  const response = await fetch(
    `${API_BASE}/api/v1/file-drafts/${encodeURIComponent(draftId)}/save`,
    {
      method: "POST",
      credentials: "include",
      headers: mutationHeaders(),
      body: "{}",
    }
  );
  if (!response.ok) {
    throw new UploadFailed(
      response.status,
      response.status === 404
        ? "This draft expired. Ask the Agent to make it again."
        : "That draft could not be saved."
    );
  }
  return (await response.json()) as LibraryFile;
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
  /** Present on servers with immutable File Version support. */
  readonly modifiedAt?: string;
  readonly revision?: number;
  readonly currentVersionId?: string;
  readonly archivedAt?: string | null;
  readonly owner: string;
  readonly ownerName?: string | null;
  /**
   * Whether the viewer may share, replace, archive or delete this File.
   *
   * Sent by the server. Comparing `owner` against the viewer's id is not the same question: a File
   * can be owned by a Team, and `owner` then names nobody who holds that power.
   */
  readonly canManage?: boolean | null;
  readonly folderId: string | null;
  readonly origin: "uploaded" | "generated";
  readonly sourceChatId: string | null;
  /** The Run that authored a generated File. `null` for anything a person uploaded. */
  readonly sourceRunId: string | null;
  /** How many grants this File carries. `null` when the caller does not own it, never 0. */
  readonly sharedWithCount: number | null;
  /**
   * Whether this File's contents are retrievable by Agents.
   *
   * Absent on any listing that is not the owner's own, for the same reason `sharedWithCount` is:
   * it is a fact about what the owner decided, not about the File as a reader sees it.
   */
  readonly inKnowledge?: boolean | null;
}

export interface FileFolder {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export async function fetchFileFolders(signal?: AbortSignal): Promise<readonly FileFolder[]> {
  const response = await fetch(`${API_BASE}/api/v1/file-folders`, {
    credentials: "include",
    headers: readHeaders(),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new UploadFailed(response.status, "Folders could not be loaded.");
  return ((await response.json()) as { folders?: FileFolder[] }).folders ?? [];
}

export async function createFileFolder(name: string, parentId: string | null): Promise<FileFolder> {
  const response = await fetch(`${API_BASE}/api/v1/file-folders`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(),
    body: JSON.stringify({ name, parentId }),
  });
  if (!response.ok) {
    throw new UploadFailed(
      response.status,
      response.status === 400
        ? "A folder with that name already exists here."
        : "That folder could not be created."
    );
  }
  return (await response.json()) as FileFolder;
}

export async function renameFileFolder(id: string, name: string): Promise<FileFolder> {
  const response = await fetch(`${API_BASE}/api/v1/file-folders/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: mutationHeaders(),
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new UploadFailed(
      response.status,
      response.status === 400
        ? "A folder with that name already exists here."
        : "That folder could not be renamed."
    );
  }
  return (await response.json()) as FileFolder;
}

export async function deleteFileFolder(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/v1/file-folders/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
    // No body, so no Content-Type: Fastify rejects an empty body declared as JSON before the
    // route ever runs, and that 400 is indistinguishable from the folder-not-empty one.
    headers: readHeaders(),
  });
  if (!response.ok) {
    throw new UploadFailed(
      response.status,
      response.status === 400
        ? "Move or delete what this folder holds before deleting it."
        : "That folder could not be deleted."
    );
  }
}

export async function moveFile(
  fileId: string,
  folderId: string | null,
  expectedRevision: number
): Promise<LibraryFile> {
  const response = await fetch(`${API_BASE}/api/v1/files/${encodeURIComponent(fileId)}/move`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(),
    body: JSON.stringify({ folderId, expectedRevision }),
  });
  if (!response.ok) throw new UploadFailed(response.status, "That file could not be moved.");
  return (await response.json()) as LibraryFile;
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

/** One page of the caller's own archived Files. */
export async function fetchArchivedFiles(
  options: { limit?: number; after?: string | null; signal?: AbortSignal } = {}
): Promise<FilePage> {
  return await fetchFilePage(
    "/api/v1/files/archived",
    "Archived files could not be loaded.",
    options
  );
}

export async function searchFiles(
  query: string,
  limit = 8,
  signal?: AbortSignal
): Promise<readonly LibraryFile[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const response = await fetch(`${API_BASE}/api/v1/files/search?${params}`, {
    credentials: "include",
    headers: readHeaders(),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new UploadFailed(response.status, "Files could not be searched.");
  return ((await response.json()) as { files?: LibraryFile[] }).files ?? [];
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

/**
 * Makes a File's contents retrievable by Agents, and citable in their answers.
 *
 * Deliberately separate from uploading. Attaching a document to one Chat and publishing it to
 * every Agent's retrieval are different decisions, so the second one is always asked for.
 */
export async function addFileToKnowledge(fileId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/v1/files/${encodeURIComponent(fileId)}/knowledge`, {
    method: "POST",
    credentials: "include",
    headers: readHeaders(),
  });
  if (!response.ok) {
    throw new UploadFailed(
      response.status,
      response.status === 501
        ? "This deployment cannot add files to knowledge."
        : "That file could not be added to knowledge."
    );
  }
}

/** Takes a File back out of retrieval. Its chunks go with it; the File itself is untouched. */
export async function removeFileFromKnowledge(fileId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/v1/files/${encodeURIComponent(fileId)}/knowledge`, {
    method: "DELETE",
    credentials: "include",
    headers: readHeaders(),
  });
  if (!response.ok) {
    throw new UploadFailed(response.status, "That file could not be removed from knowledge.");
  }
}

/**
 * Destroys a File permanently. There is nothing to undo this with, on either side of the wire.
 */
export async function deleteFile(fileId: string, expectedRevision: number): Promise<void> {
  const query = new URLSearchParams({ expectedRevision: String(expectedRevision) });
  const response = await fetch(`${API_BASE}/api/v1/files/${encodeURIComponent(fileId)}?${query}`, {
    method: "DELETE",
    credentials: "include",
    headers: readHeaders(),
  });
  if (!response.ok) throw new UploadFailed(response.status, "That file could not be deleted.");
}

export async function archiveFile(fileId: string, expectedRevision: number): Promise<LibraryFile> {
  return await mutateFile(`/api/v1/files/${encodeURIComponent(fileId)}/archive`, {
    expectedRevision,
  });
}

export async function restoreArchivedFile(
  fileId: string,
  expectedRevision: number
): Promise<LibraryFile> {
  return await mutateFile(`/api/v1/files/${encodeURIComponent(fileId)}/restore`, {
    expectedRevision,
  });
}

export async function restoreFileVersion(
  fileId: string,
  versionId: string,
  expectedRevision: number
): Promise<LibraryFile> {
  return await mutateFile(
    `/api/v1/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/restore`,
    { expectedRevision }
  );
}

async function mutateFile(path: string, body: { expectedRevision: number }): Promise<LibraryFile> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: mutationHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new UploadFailed(response.status, "That file could not be changed.");
  return (await response.json()) as LibraryFile;
}

export async function replaceFile(
  fileId: string,
  expectedRevision: number,
  file: File
): Promise<LibraryFile> {
  const headers = readHeaders();
  headers["Content-Type"] = file.type || "application/octet-stream";
  const query = new URLSearchParams({ expectedRevision: String(expectedRevision) });
  const response = await fetch(
    `${API_BASE}/api/v1/files/${encodeURIComponent(fileId)}/content?${query}`,
    {
      method: "PUT",
      credentials: "include",
      headers,
      body: file,
    }
  );
  if (!response.ok) {
    throw new UploadFailed(
      response.status,
      response.status === 415
        ? "The replacement must use the same file format."
        : "That file could not be replaced."
    );
  }
  return (await response.json()) as LibraryFile;
}

export interface FileVersion {
  readonly id: string;
  readonly versionNumber: number;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly actorKind: "principal" | "agent" | "routine" | "system";
  readonly actorId: string;
  readonly reason: "created" | "replaced" | "restored";
  readonly sourceChatId: string | null;
  readonly sourceRunId: string | null;
  readonly restoredFromVersionId: string | null;
  readonly createdAt: string;
}

export async function fetchFileVersions(
  fileId: string,
  signal?: AbortSignal
): Promise<readonly FileVersion[]> {
  const response = await fetch(`${API_BASE}/api/v1/files/${encodeURIComponent(fileId)}/versions`, {
    credentials: "include",
    headers: readHeaders(),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new UploadFailed(response.status, "Version history could not be loaded.");
  return ((await response.json()) as { versions?: FileVersion[] }).versions ?? [];
}

export async function fetchFileVersionObjectUrl(
  fileId: string,
  versionId: string,
  signal?: AbortSignal
): Promise<string> {
  return await fetchObjectUrl(
    `/api/v1/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/content`,
    signal
  );
}

async function fetchObjectUrl(path: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: readHeaders(),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new UploadFailed(response.status, "That file could not be loaded.");
  return URL.createObjectURL(await response.blob());
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
export async function fetchFile(fileId: string, signal?: AbortSignal): Promise<LibraryFile> {
  const response = await fetch(`${API_BASE}/api/v1/files/${encodeURIComponent(fileId)}`, {
    credentials: "include",
    headers: readHeaders(),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new UploadFailed(response.status, "That file could not be found.");
  return (await response.json()) as LibraryFile;
}
