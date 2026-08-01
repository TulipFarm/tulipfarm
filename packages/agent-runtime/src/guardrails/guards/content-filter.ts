import type { ContentFilterConfig } from "@tulipfarm/schema";
import type { Guard, Verdict } from "../pipeline";

type Pattern = ContentFilterConfig["patterns"][number];

/**
 * Luhn checksum over a digit-only string. Used to weed out the many 13–19 digit
 * sequences (order ids, tracking numbers) that are not real card numbers.
 */
function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// 13–19 digit sequences, optionally split into groups by single spaces/hyphens.
const CREDIT_CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const API_KEY = [/\bsk-[A-Za-z0-9]{16,}\b/, /\bAKIA[0-9A-Z]{16}\b/, /\bghp_[A-Za-z0-9]{36}\b/];
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

const MATCHERS: Record<Pattern, (text: string) => boolean> = {
  credit_card(text) {
    for (const match of text.matchAll(CREDIT_CARD)) {
      if (luhn(match[0].replace(/[^0-9]/g, ""))) return true;
    }
    return false;
  },
  ssn: (text) => SSN.test(text),
  api_key: (text) => API_KEY.some((re) => re.test(text)),
  email: (text) => EMAIL.test(text),
};

/**
 * Output guard that blocks model responses leaking sensitive data. Only the
 * pattern keys listed in `cfg.patterns` are active; the first active match wins.
 */
export function makeContentFilterGuard(cfg: ContentFilterConfig): Guard<string> {
  const message = "The response was blocked by a content guardrail.";
  return {
    name: "content_filter",
    run(text: string): Verdict<string> {
      for (const pattern of cfg.patterns) {
        if (MATCHERS[pattern](text)) {
          return { action: "block", reason: `content_filter:${pattern}`, message };
        }
      }
      return { action: "pass" };
    },
  };
}
