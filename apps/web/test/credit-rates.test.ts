import assert from 'node:assert/strict';
import { test } from 'node:test';
import { creditRates } from '../src/features/models/credit-rates.ts';

test('credit rates show input and output, and families without rates are not priced', () => {
  assert.equal(creditRates({ inputCreditsPerMillionTokens: 300, outputCreditsPerMillionTokens: 1500 }), '300 / 1,500');
  assert.equal(creditRates({ inputCreditsPerMillionTokens: null, outputCreditsPerMillionTokens: null }), 'Not priced');
});
