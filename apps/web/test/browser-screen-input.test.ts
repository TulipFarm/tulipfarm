import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inputModifiers, typedText, viewportPoint } from '../src/features/browser/screen-input.ts';

test('a click on the scaled screen lands on the same spot in the browser', () => {
  const rect = { left: 100, top: 50, width: 640, height: 400 };
  assert.deepEqual(viewportPoint(rect, 100, 50), { x: 0, y: 0 });
  assert.deepEqual(viewportPoint(rect, 420, 250), { x: 640, y: 400 });
  assert.deepEqual(viewportPoint(rect, 740, 450), { x: 1280, y: 800 });
  assert.deepEqual(viewportPoint(rect, 2000, -10), { x: 1280, y: 0 }, 'points outside the screen are clamped');
  assert.deepEqual(viewportPoint({ ...rect, width: 0, height: 0 }, 100, 50), { x: 0, y: 0 });
});

test('keys carry their modifiers and only printable keys type text', () => {
  const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.equal(inputModifiers(none), 0);
  assert.equal(inputModifiers({ ...none, altKey: true, shiftKey: true }), 9);
  assert.equal(inputModifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true }), 15);
  assert.equal(typedText({ key: 'a', metaKey: false, ctrlKey: false }), 'a');
  assert.equal(typedText({ key: 'Enter', metaKey: false, ctrlKey: false }), undefined);
  assert.equal(typedText({ key: 'a', metaKey: true, ctrlKey: false }), undefined);
});
