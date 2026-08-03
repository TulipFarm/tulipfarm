import type { SoulLoader } from "@tulipfarm/soul";
import { CATALOG } from "./catalog";

/** A suggestion projected for the client — the `resources` match key is stripped. */
export interface Suggestion {
  id: string;
  label: string;
  prompt: string;
}

/**
 * Derive the adaptive onboarding suggestions for the current soul state (ONB-V1-003).
 * Pure: keeps a catalog entry iff none of the resource name(s) it would create already exist in the
 * soul, then projects to `{ id, label, prompt }` (dropping the `resources` match key). Typed against
 * the minimal `resources` map slice so it is trivially testable with a stub.
 */
export function deriveSuggestions(soulLoader: Pick<SoulLoader, "resources">): Suggestion[] {
  return CATALOG.filter((e) => !e.resources.some((r) => soulLoader.resources.has(r))).map(
    ({ id, label, prompt }) => ({ id, label, prompt })
  );
}
