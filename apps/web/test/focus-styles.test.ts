import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const stylesheet = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');

test('global focus ring is limited to interactive controls', () => {
  const focusRing = stylesheet.match(
    /^\s*:where\(([\s\S]*?)\):focus-visible\s*\{\s*outline: 1px solid var\(--ring\);\s*outline-offset: 1px;\s*\}/m,
  );
  assert.ok(focusRing, 'expected the global focus ring to target an explicit set of controls');
  assert.match(
    stylesheet,
    /^\s*:focus-visible\s*\{\s*outline: none;\s*\}/m,
    'unlisted focus targets must not inherit browser focus outlines',
  );

  const selectors = new Set(focusRing[1]!.split(',').map(selector => selector.trim().replaceAll("'", '"')));
  for (const selector of [
    'button',
    'input',
    'textarea',
    'select',
    'summary',
    'a[href]',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="tab"]',
    '[role="listbox"]',
    '[role="slider"]',
  ]) {
    assert.ok(selectors.has(selector), `global focus ring should include ${selector}`);
  }
  assert.ok(
    !selectors.has('[tabindex]') && !selectors.has('[role="region"]') && !selectors.has('[role="tabpanel"]'),
    'generic focus targets and scroll regions must not receive the global ring',
  );
});
