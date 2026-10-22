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
  const sidebar = source('components/sidebar.tsx');
  assert.match(sidebar, /h-\[calc\(100svh-var\(--consent-inset,0px\)\)\]/);
  assert.match(sidebar, /bottom-\(--consent-inset,0px\)/);
});

test('selected navigation has a visible active marker', () => {
  assert.match(source('components/sidebar.tsx'), /data-active:shadow-\[inset_3px_0_0_var\(--color-primary\)\]/);
});

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const blend = (top: string, bottom: string, alpha: number) =>
  '#' +
  [1, 3, 5]
    .map(i =>
      Math.round(parseInt(top.slice(i, i + 2), 16) * alpha + parseInt(bottom.slice(i, i + 2), 16) * (1 - alpha))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

test('small grey shell text meets WCAG AA in light and dark themes', () => {
  const token = themeColor;
  const pairs: [string, string[]][] = [
    ['sidebar-muted-foreground', ['sidebar', 'accent']],
    ['muted-foreground', ['background', 'card', 'muted']],
  ];
  for (const theme of [0, 1]) {
    for (const [text, surfaces] of pairs) {
      for (const surface of surfaces)
        assert.ok(
          contrast(token(text)[theme], token(surface)[theme]) >= 4.5,
          `${text} on ${surface} (${theme ? 'dark' : 'light'})`,
        );
    }
    assert.ok(
      contrast(token('sidebar-muted-foreground')[theme], blend(token('accent')[theme], token('sidebar')[theme], 0.6)) >=
        4.5,
    );
  }
  for (const path of ['components/sidebar.tsx', 'features/navigation/sidebar-recent-item.tsx'])
    assert.doesNotMatch(source(path), /text-muted-foreground/);
});
