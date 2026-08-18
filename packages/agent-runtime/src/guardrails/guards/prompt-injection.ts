import type { PromptInjectionConfig } from "@tulipfarm/schema";
import type { Guard, Verdict } from "../pipeline";

type Sensitivity = NonNullable<PromptInjectionConfig["sensitivity"]>;

interface InjectionPattern {
  readonly category: string;
  readonly re: RegExp;
}

/** Additive jailbreak tiers; `category` becomes the block reason. */
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

/**
 * Digits that stand in for letters in leetspeak, and the letter each one restores.
 *
 * Only the unambiguous substitutions. `2`/`9`/`6` are also used for `z`/`g`/`b` in some dialects,
 * but they appear far more often as ordinary digits — restoring them would corrupt order numbers
 * and dates into words for no detection gain this Corpus can demonstrate.
 */
const LEET_DIGITS: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
};

/** A base64-looking run long enough to hide an instruction in. */
const BASE64_RUN = /[A-Za-z0-9+/]{16,}={0,2}/g;

/** Bounds on decoding, so a large message cannot turn one guard call into arbitrary work. */
const MAX_DECODES = 12;
const MAX_RUN_LENGTH = 8192;

function deleet(text: string): string {
  return text.replace(/[013457]/g, (digit) => LEET_DIGITS[digit] ?? digit);
}

/**
 * Mostly-printable text, which random bytes are not.
 *
 * An arbitrary run of characters is valid base64, so most decodes are binary noise. Scanning that
 * noise risks a pattern matching by coincidence — `\bDAN\b` is three characters — and a guard that
 * blocks at random teaches operators to lower its sensitivity.
 */
function readable(text: string): boolean {
  if (text.length === 0) return false;
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) printable += 1;
  }
  return printable / text.length > 0.9;
}

function decodedRuns(text: string): string[] {
  const out: string[] = [];
  for (const [run] of text.matchAll(BASE64_RUN)) {
    if (out.length >= MAX_DECODES) break;
    if (run.length > MAX_RUN_LENGTH) continue;
    const decoded = Buffer.from(run, "base64").toString("utf8");
    if (readable(decoded)) out.push(decoded);
  }
  return out;
}

/**
 * Every reading of the message a pattern should be tested against.
 *
 * A literal matcher only sees the spelling the attacker chose. Restoring the obvious disguises
 * first — leet digits, and base64 the message carries inline — closes the gap between "the harness
 * has no defence" and "the defence was spelled around", which is the difference between a real
 * finding and a bypass. The raw text is always first, so this can only ever add a detection.
 */
function readings(text: string): string[] {
  const out = [text];
  const plain = deleet(text);
  if (plain !== text) out.push(plain);
  for (const decoded of decodedRuns(text)) {
    out.push(decoded);
    const decodedPlain = deleet(decoded);
    if (decodedPlain !== decoded) out.push(decodedPlain);
  }
  return out;
}

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
      const candidates = readings(text);
      for (const { category, re } of patterns) {
        if (candidates.some((candidate) => re.test(candidate))) {
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
