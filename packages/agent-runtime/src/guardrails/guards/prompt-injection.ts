import type { PromptInjectionConfig } from "@tulipfarm/schema";
import type { Guard, Verdict } from "../pipeline";

type Sensitivity = NonNullable<PromptInjectionConfig["sensitivity"]>;

interface InjectionPattern {
  readonly category: string;
  readonly re: RegExp;
}

/**
 * Tiered jailbreak/prompt-injection patterns. Tiers are additive: `medium`
 * includes every `low` pattern, `high` includes every `medium` pattern. Each
 * pattern carries a human-readable `category` used as the block `reason` so
 * logs/UI surface *what kind* of injection matched rather than a raw regex.
 */
const PATTERNS: Readonly<Record<Sensitivity, readonly InjectionPattern[]>> = {
  // Blatant attempts to override the standing instructions.
  low: [
    {
      category: "instruction_override",
      re: /ignore (all )?(previous|prior|above) (instructions|messages)/i,
    },
    { category: "instruction_override", re: /disregard (the )?(above|previous|system)/i },
  ],
  // Mode hijacking, instruction override, and prompt exfiltration — high-precision
  // signals safe to enable by default (the default policy uses `medium`).
  medium: [
    { category: "mode_override", re: /developer mode/i },
    { category: "mode_override", re: /\bDAN\b/ },
    { category: "instruction_override", re: /ignore your (system )?(prompt|instructions)/i },
    { category: "prompt_exfiltration", re: /reveal your (system )?(prompt|instructions)/i },
  ],
  // Broader, looser jailbreak phrasing (higher false-positive tolerance). Bare role-play
  // reassignment ("you are now …", "pretend to be …") lives here, NOT `medium`: it is too
  // broad for the default policy (e.g. "how you are now configured", "pretend you are a chef").
  high: [
    { category: "role_override", re: /\byou are now\b/i },
    { category: "role_override", re: /\bpretend (to be|you are)\b/i },
    { category: "jailbreak", re: /\bjailbreak\b/i },
    { category: "unrestricted", re: /no (restrictions|rules|filter)/i },
    { category: "bypass_safety", re: /bypass (your )?(safety|guardrails|rules)/i },
    { category: "jailbreak", re: /do anything now/i },
  ],
} as const;

function activePatterns(sensitivity: Sensitivity): readonly InjectionPattern[] {
  if (sensitivity === "low") return PATTERNS.low;
  if (sensitivity === "medium") return [...PATTERNS.low, ...PATTERNS.medium];
  return [...PATTERNS.low, ...PATTERNS.medium, ...PATTERNS.high];
}

export function makePromptInjectionGuard(cfg: PromptInjectionConfig): Guard<string> {
  const patterns = activePatterns(cfg.sensitivity ?? "medium");

  return {
    name: "prompt_injection",
    run(text: string, _ctx): Verdict<string> {
      for (const { category, re } of patterns) {
        if (re.test(text)) {
          return {
            action: "block",
            reason: `prompt_injection:${category}`,
            message: "This request was blocked by a safety guardrail.",
          };
        }
      }
      return { action: "pass" };
    },
  };
}
