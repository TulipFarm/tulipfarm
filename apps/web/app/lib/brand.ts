/** Clamp brand hexes in OKLCH per canvas so runtime colours stay legible and on-brand. */

/** Above this the mark is too pale to read on the white canvas. */
const LIGHT_CEILING = 0.62;
/** Below this the mark is too dark to read on the `oklch(0.145 0.002 286)` dark canvas. */
const DARK_FLOOR = 0.72;

export type BrandInk = {
  /** Mark colour for the light canvas. */
  light: string;
  /** Mark colour for the dark canvas. */
  dark: string;
};

const HEX = /^#?([0-9a-f]{6})$/i;

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** sRGB hex to OKLCH, per Björn Ottosson's reference conversion. */
function toOklch(hex: string): { l: number; c: number; h: number } | null {
  const match = HEX.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  const r = toLinear(((value >> 16) & 0xff) / 255);
  const g = toLinear(((value >> 8) & 0xff) / 255);
  const b = toLinear((value & 0xff) / 255);

  const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const l = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
  const a = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short;
  const bAxis = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short;

  const c = Math.hypot(a, bAxis);
  // Hue is meaningless once chroma rounds away, and atan2 on noise yields a random angle. Pinning
  // it to 0 keeps a grey brand grey instead of letting it drift into a tint when lightened.
  const h = c < 0.0005 ? 0 : ((Math.atan2(bAxis, a) * 180) / Math.PI + 360) % 360;
  return { l, c, h };
}

function css(l: number, c: number, h: number): string {
  return `oklch(${l.toFixed(3)} ${c.toFixed(4)} ${h.toFixed(1)})`;
}

/** Return both theme-safe colours so CSS can switch themes without JavaScript. */
export function brandInk(hex: string | null | undefined): BrandInk | null {
  if (!hex) return null;
  const oklch = toOklch(hex);
  if (!oklch) return null;
  const { c, h } = oklch;
  return {
    light: css(Math.min(oklch.l, LIGHT_CEILING), c, h),
    dark: css(Math.max(oklch.l, DARK_FLOOR), c, h),
  };
}
