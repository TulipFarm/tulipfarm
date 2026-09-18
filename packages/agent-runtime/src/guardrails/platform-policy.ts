import { canonicalHash, type GuardrailsConfig } from "@tulipfarm/schema";
import { DEFAULT_GUARDRAILS } from "./default-policy";

/** Hosted minimums are runtime-owned, never read from the customer-authored Soul. */
export function platformGuardrailsFor(
  hostingAuthority: "independent" | "tulipfarm"
): GuardrailsConfig | undefined {
  return hostingAuthority === "tulipfarm" ? structuredClone(DEFAULT_GUARDRAILS) : undefined;
}

/** Each existing guard can only block or redact; running both policies narrows permitted work. */
export function intersectGuardrails(
  platform: GuardrailsConfig,
  business: GuardrailsConfig
): GuardrailsConfig {
  return {
    input: union(platform.input, business.input),
    "tool-call": union(platform["tool-call"], business["tool-call"]),
    "tool-result": union(platform["tool-result"], business["tool-result"]),
    output: union(platform.output, business.output),
  };
}

function union<T>(platform: T[] = [], business: T[] = []): T[] {
  return [
    ...new Map([...platform, ...business].map((guard) => [canonicalHash(guard), guard])).values(),
  ];
}
