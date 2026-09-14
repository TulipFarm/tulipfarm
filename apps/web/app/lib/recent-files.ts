import type { UploadedFile } from "./files";

/**
 * A quick-access history of Files the person just created, uploaded, or attached, for surfaces
 * that want to offer them again before a search is typed (the chat File picker; anywhere else that
 * grows the same need). Per-browser, not per-account — same tradeoff as `theme.ts`.
 */
const RECENT_FILES_STORAGE_KEY = "recent-files";
const MAX_RECENT_FILES = 10;

function isUploadedFile(value: unknown): value is UploadedFile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.filename === "string" &&
    typeof candidate.mediaType === "string" &&
    typeof candidate.sizeBytes === "number" &&
    typeof candidate.createdAt === "string"
  );
}

/** Recently touched Files, most recent first. */
export function readRecentFiles(): readonly UploadedFile[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_FILES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isUploadedFile) : [];
  } catch {
    return [];
  }
}

/** Moves `file` to the front of the recent-files history, capped at `MAX_RECENT_FILES`. */
export function recordRecentFile(file: UploadedFile): void {
  if (typeof localStorage === "undefined") return;
  try {
    const next = [file, ...readRecentFiles().filter((entry) => entry.id !== file.id)].slice(
      0,
      MAX_RECENT_FILES
    );
    localStorage.setItem(RECENT_FILES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* Private-mode storage failures must not stop the attachment itself. */
  }
}
