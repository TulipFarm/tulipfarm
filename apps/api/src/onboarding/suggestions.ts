import type { SoulLoader } from "@tulipfarm/soul";
import { CATALOG } from "./catalog";

/** A suggestion projected for the client — the `resources` match key is stripped. */
export interface Suggestion {
  id: string;
  label: string;
  prompt: string;
}

/** ONB-V1-003 suggestions omit entries whose target Resources already exist. */
export function deriveSuggestions(soulLoader: Pick<SoulLoader, "resources">): Suggestion[] {
  return CATALOG.filter((e) => !e.resources.some((r) => soulLoader.resources.has(r))).map(
    ({ id, label, prompt }) => ({ id, label, prompt })
  );
}
