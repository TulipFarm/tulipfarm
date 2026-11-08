import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transformErrorHelp } from '../src/features/tables/transform-errors.ts';

test('exponent notation names the value and asks for a plain decimal', () => {
  for (const value of ['1e3', '-2.5E-4', '.5e1'])
    assert.equal(
      transformErrorHelp('conversion-failed', value),
      `“${value}” is in exponent notation. Numbers must be plain decimals, such as 1000. Rewrite the value without the “e”.`,
    );
});

test('other failed conversions name the value and the accepted formats', () => {
  assert.match(
    transformErrorHelp('conversion-failed', 'abc'),
    /^“abc” can’t be converted .* plain decimals such as 42\.5/,
  );
  assert.match(transformErrorHelp('conversion-failed', '1e'), /^“1e” can’t be converted/);
  assert.match(transformErrorHelp('conversion-failed', null), /^This value can’t be converted/);
});

test('every transform error code reads in plain words with a fix', () => {
  for (const code of [
    'invalid-input',
    'missing-field',
    'type-mismatch',
    'unmapped-value',
    'conversion-failed',
    'split-index',
    'invalid-output',
  ]) {
    const help = transformErrorHelp(code, '0.001');
    assert.equal(help.includes(code), false, code);
    assert.match(help, /Correct|Ask the assistant|Rewrite/, code);
  }
  assert.match(transformErrorHelp('invalid-output', '0.001'), /^“0\.001” .*decimal places/);
  assert.match(transformErrorHelp('invalid-output', 'Not set'), /^This value .*empty when a value is required/);
});
