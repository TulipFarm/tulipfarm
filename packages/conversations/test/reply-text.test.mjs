import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutTrailingControlMarker } from '../src/reply-text.ts';

test('only a whole trailing marker line is removed', () => {
  for (const ending of ['', ' ', '\n', '\r\n\n'])
    assert.equal(withoutTrailingControlMarker(`Answer.\nTULIPMEM${ending}`), 'Answer.');
  assert.equal(withoutTrailingControlMarker('TULIPMEM'), '');
  for (const text of [
    'Explain TULIPMEM.',
    'Answer. TULIPMEM',
    '> TULIPMEM',
    '"TULIPMEM"',
    '`TULIPMEM`',
    '```\nTULIPMEM\n```',
    'TULIPMEM\nMore text.',
    'TULIPMEMORY',
    ' TULIPMEM',
    'Answer.\nTU',
  ])
    assert.equal(withoutTrailingControlMarker(text), text);
});

test('streaming withholds split trailing prefixes but restores ordinary words and quoted text', () => {
  for (let length = 1; length <= 'TULIPMEM'.length; length++) {
    const prefix = 'TULIPMEM'.slice(0, length);
    assert.equal(withoutTrailingControlMarker(`Answer.\n${prefix}`, true), 'Answer.');
    assert.equal(withoutTrailingControlMarker(prefix, true), '');
    assert.equal(withoutTrailingControlMarker(`Answer. ${prefix}`, true), `Answer. ${prefix}`);
    assert.equal(withoutTrailingControlMarker(`> ${prefix}`, true), `> ${prefix}`);
  }
  assert.equal(withoutTrailingControlMarker('Answer.\nTuesday', true), 'Answer.\nTuesday');
});

test('stripping and stream-prefix withholding have no logging side effects', t => {
  const lines = [];
  t.mock.method(process.stdout, 'write', line => {
    lines.push(line);
    return true;
  });
  withoutTrailingControlMarker('Private answer.\nTULIPMEM');
  withoutTrailingControlMarker('Private answer.\nTULIPMEM', true);
  withoutTrailingControlMarker('Private answer.\nTULIP', true);
  assert.deepEqual(lines, []);
});
