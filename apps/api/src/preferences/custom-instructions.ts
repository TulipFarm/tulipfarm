import type { KvService } from "../kv/service";

/**
 * KV coordinates for a person's standing instructions. Lives in the generic `kv_store` under
 * `scope='user'` rather than a dedicated table: the value is one text blob per person with no
 * relations, no history, and no query beyond "read mine".
 *
 * Agent KV tools are hard-wired to `scope='agent'` (see `kv/README.md`), so nothing an agent can
 * call reaches this key. That matters more than the saved migration — instructions an agent could
 * rewrite would not be the user's instructions any more.
 */
export const CUSTOM_INSTRUCTIONS_NAMESPACE = "preferences";
export const CUSTOM_INSTRUCTIONS_KEY = "custom-instructions";

/** Returns the stored text, or undefined when unset or blank — the prompt block omits either way. */
export async function readCustomInstructions(
  kv: KvService,
  userId: string
): Promise<string | undefined> {
  const entry = await kv.get(
    "user",
    userId,
    CUSTOM_INSTRUCTIONS_NAMESPACE,
    CUSTOM_INSTRUCTIONS_KEY
  );
  return typeof entry?.value === "string" && entry.value.trim().length > 0
    ? entry.value
    : undefined;
}
