import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A content hash is provenance, not an identifier anyone types. Full length buries the sentence
 * it sits in, so show enough to match against a log line and no more.
 */
export function shortRevision(revision: string): string {
  return revision.slice(0, 12);
}
