import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelOption } from './browser-controls.mjs';

const page = {
  getByRole(role: string, options: { name: RegExp }) {
    assert.equal(role, 'option');
    return options.name;
  },
};

test('model options match whichever metric is first, or no metrics', () => {
  const name = modelOption(page, 'Grok');
  for (const suffix of ['', ' Speed 3 of 5, middle.', ' Quality 3 of 5, middle.', ' Cost 3 of 5, middle.']) {
    assert.match(`Grok${suffix}`, name);
  }
  assert.match('Grok Unavailable: disabled in workspace Cost 3 of 5, middle.', name);
  assert.doesNotMatch('Grok Fast Cost 3 of 5, middle.', name);
});

test('model option names containing regex characters are matched literally', () => {
  const name = modelOption(page, 'Model (v1.2)');
  assert.match('Model (v1.2) Cost 3 of 5, middle.', name);
  assert.doesNotMatch('Model v1x2 Cost 3 of 5, middle.', name);
});
