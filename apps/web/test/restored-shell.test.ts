import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { themeColor } from './sprout-theme.ts';

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('settled chats explain that replying still works and what the recap does', () => {
  const copy = source('features/chat/maintenance.tsx');
  assert.doesNotMatch(copy, /This chat is inactive/);
  assert.doesNotMatch(copy, /next background run/);
  assert.match(copy, /You can keep replying here\./);
});

test('analytics consent reserves space instead of covering the composer', () => {
  const consent = source('components/analytics-consent.tsx');
  assert.match(consent, /--consent-inset/);
  assert.match(consent, /removeProperty\(insetProperty\)/);
  assert.match(source('pages/workspace.tsx'), /h-svh[^"]*pb-\(--consent-inset,0px\)/);
});

test('selected navigation passes its active state to the Sprout sidebar', () => {
  assert.match(source('pages/workspace.tsx'), /isActive=\{active\}/);
  assert.match(source('features/navigation/sidebar-recent-item.tsx'), /isActive=\{entry\.active\}/);
});

type Rgb = [number, number, number];
const opacity = (color: string) => Number(color.match(/\/\s*([\d.]+)\s*\)$/)?.[1] ?? 1);
const channels = (color: string): Rgb => {
  if (color.startsWith('#'))
    return [1, 3, 5].map(i => {
      const v = parseInt(color.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
  const match = color.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*[\d.]+\s*)?\)$/);
  if (!match) throw new Error(`Unsupported colour ${color}`);
  const [l, c, h] = match.slice(1).map(Number);
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const lms = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map(v => v ** 3);
  return [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ].map(v => Math.min(1, Math.max(0, v))) as [number, number, number];
};
const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const contrast = (a: string | Rgb, b: string | Rgb) => {
  const [x, y] = [a, b].map(c => luminance(typeof c === 'string' ? channels(c) : c)).sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const encode = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
/** Alpha-composites in gamma-encoded sRGB, as the browser does. */
const blend = (top: string | Rgb, bottom: string | Rgb, alpha: number) => {
  const [t, u] = [top, bottom].map(c => (typeof c === 'string' ? channels(c) : c));
  return t.map((v, i) => decode(encode(v) * alpha + encode(u[i]) * (1 - alpha))) as Rgb;
};
/** Paints a possibly translucent token over an opaque one. */
const over = (top: string, bottom: string) => blend(top, bottom, opacity(top));

test('idle input edges keep at least 1.5:1 contrast against the control surface in both themes', () => {
  for (const theme of [0, 1])
    assert.ok(
      contrast(themeColor('input')[theme], themeColor('card')[theme]) >= 1.5,
      `input on card (${theme ? 'dark' : 'light'})`,
    );
});

test('small grey shell text meets WCAG AA in light and dark themes', () => {
  const token = themeColor;
  // `accent` and `muted` are translucent overlays, so each is checked over the surface it sits on.
  const pairs: [string, [string, string?][]][] = [
    ['sidebar-muted-foreground', [['sidebar'], ['accent', 'sidebar']]],
    ['muted-foreground', [['background'], ['card'], ['muted', 'card'], ['muted', 'background']]],
  ];
  for (const theme of [0, 1]) {
    for (const [text, surfaces] of pairs) {
      for (const [surface, base] of surfaces)
        assert.ok(
          contrast(
            token(text)[theme],
            base ? over(token(surface)[theme], token(base)[theme]) : token(surface)[theme],
          ) >= 4.5,
          `${text} on ${base ? `${surface} over ${base}` : surface} (${theme ? 'dark' : 'light'})`,
        );
    }
    const hover = over(token('accent')[theme], token('sidebar')[theme]);
    assert.ok(contrast(token('sidebar-muted-foreground')[theme], blend(hover, token('sidebar')[theme], 0.6)) >= 4.5);
  }
  assert.doesNotMatch(source('features/navigation/sidebar-recent-item.tsx'), /text-muted-foreground/);
});
