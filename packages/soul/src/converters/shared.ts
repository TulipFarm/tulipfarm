import { createHash } from "node:crypto";
import type { SoulFileChange } from "../changeset";

/** Pure helpers for proposing legacy Soul -> authored-definition changes. */

/** Why a legacy value did not make it into the converted definition. */
export type ConversionWarningCode =
  | "UNMAPPED_FIELD"
  | "SECRET_FIELD_DROPPED"
  | "MISSING_REQUIRED_FIELD";

export interface ConversionWarning {
  readonly code: ConversionWarningCode;
  readonly field: string;
}

/** Result of converting one legacy artifact: proposed file writes plus any loss warnings. */
export interface ConversionResult {
  readonly files: readonly SoulFileChange[];
  readonly warnings: readonly ConversionWarning[];
}

/** Field-name pattern that always excludes a legacy value, even if it collides with an allowlisted name. */
const SECRET_FIELD_PATTERN = /secret|token|password|credential|apikey|api_key/i;

/** Fixed namespace so the same (kind, name) always derives the same id. */
const ID_NAMESPACE = "tulipfarm.ai/soul/legacy-definition/v1";

/** Stable SHA-256-derived UUID-shaped id for idempotent legacy conversion. */
export function deriveDefinitionId(kind: string, name: string): string {
  const digest = createHash("sha256")
    .update(`${ID_NAMESPACE}\0${kind}\0${name}`, "utf8")
    .digest("hex");
  const hex = digest.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** True for the 36 characters a slug may contain: `a`-`z`, `0`-`9`. */
function isSlugChar(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
}

/** Linear-time slug normalization for uncontrolled legacy names; avoids regex ReDoS shapes. */
export function slugify(name: string): string {
  const lower = name.toLowerCase();
  let base = "";
  let pendingHyphen = false;
  for (const char of lower) {
    if (isSlugChar(char)) {
      if (pendingHyphen && base.length > 0) base += "-";
      pendingHyphen = false;
      base += char;
    } else {
      pendingHyphen = true;
    }
  }
  return base.length > 0 && base.charAt(0) >= "a" && base.charAt(0) <= "z"
    ? base
    : `x-${base || "unnamed"}`;
}

/** Copy only allowlisted fields; drop secret-shaped names and warn on other unmapped fields. */
export function mapAllowlistedFields(
  frontmatter: Record<string, unknown>,
  allowlist: readonly string[]
): { mapped: Record<string, unknown>; warnings: ConversionWarning[] } {
  const allowed = new Set(allowlist);
  const mapped: Record<string, unknown> = {};
  const warnings: ConversionWarning[] = [];

  for (const [field, value] of Object.entries(frontmatter)) {
    if (SECRET_FIELD_PATTERN.test(field)) {
      warnings.push({ code: "SECRET_FIELD_DROPPED", field });
      continue;
    }
    if (allowed.has(field)) {
      mapped[field] = value;
      continue;
    }
    warnings.push({ code: "UNMAPPED_FIELD", field });
  }

  return { mapped, warnings };
}
