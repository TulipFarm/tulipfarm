import { ApiError } from "./api";

/**
 * Maps a rejection onto the field that caused it, so the fix is offered where the mistake was made.
 * A message with nowhere to land stays at the top of the form rather than being dropped.
 */
export function pageFormErrors(err: unknown): {
  formError: string | null;
  fieldErrors: Partial<Record<"path" | "content", string>>;
} {
  const message = err instanceof Error ? err.message : "request failed";
  if (err instanceof ApiError) {
    if (err.status === 409) return { formError: null, fieldErrors: { path: message } };
    if (err.path?.includes("path")) return { formError: null, fieldErrors: { path: message } };
    if (err.path?.includes("content"))
      return { formError: null, fieldErrors: { content: message } };
  }
  return { formError: message, fieldErrors: {} };
}
