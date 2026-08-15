import type { KvService } from "@tulipfarm/kv";

/** User-scoped KV coordinates; agent KV tools cannot reach these instructions. */
export const CUSTOM_INSTRUCTIONS_NAMESPACE = "preferences";
export const CUSTOM_INSTRUCTIONS_KEY = "custom-instructions";

/** Returns stored text; unset or blank instructions are omitted from the prompt. */
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
