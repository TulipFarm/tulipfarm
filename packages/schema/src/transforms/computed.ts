import { createHash, randomUUID } from "node:crypto";

export const COMPUTED_FN_KEYS = ["sha256", "uuid", "sequence"] as const;

export type ComputedFnKey = (typeof COMPUTED_FN_KEYS)[number];

export type CounterFn = (resourceType: string) => Promise<number>;

interface ComputedFnArgs {
  values: string[];
  resourceType: string;
  counter?: CounterFn;
}

const COMPUTED_FNS: Record<ComputedFnKey, (args: ComputedFnArgs) => Promise<string>> = {
  sha256: async ({ values }) => createHash("sha256").update(values.join("")).digest("hex"),
  uuid: async () => randomUUID(),
  sequence: async ({ resourceType, counter }) => {
    if (!counter) throw new Error("counter required for fn: sequence");
    return String(await counter(resourceType));
  },
};

export async function applyComputedFn(fn: ComputedFnKey, args: ComputedFnArgs): Promise<string> {
  return COMPUTED_FNS[fn](args);
}

export function isComputedFnKey(key: unknown): key is ComputedFnKey {
  return typeof key === "string" && (COMPUTED_FN_KEYS as readonly string[]).includes(key);
}
