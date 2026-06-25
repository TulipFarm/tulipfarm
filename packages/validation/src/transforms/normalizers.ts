export const NORMALIZER_KEYS = [
  "trim",
  "lowercase",
  "uppercase",
  "slugify",
  "phone-e164",
  "email-normalize",
] as const;

export type NormalizerKey = (typeof NORMALIZER_KEYS)[number];

const NORMALIZERS: Record<NormalizerKey, (v: string) => string> = {
  trim: (v) => v.trim(),
  lowercase: (v) => v.toLowerCase(),
  uppercase: (v) => v.toUpperCase(),
  slugify: (v) =>
    v
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, ""),
  // US-only V1: strip non-digits, prepend +1
  "phone-e164": (v) => `+1${v.replace(/\D/g, "")}`,
  "email-normalize": (v) => v.trim().toLowerCase(),
};

export function applyNormalizer(key: NormalizerKey, value: string): string {
  return NORMALIZERS[key](value);
}

export function isNormalizerKey(key: unknown): key is NormalizerKey {
  return typeof key === "string" && (NORMALIZER_KEYS as readonly string[]).includes(key);
}
