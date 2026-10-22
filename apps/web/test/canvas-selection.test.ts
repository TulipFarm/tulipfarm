import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasSelection, emptyCanvas } from '../src/features/chat/canvas-selection.ts';
import type { CanvasItem } from '../src/features/chat/canvas-state.tsx';

const item = (id: string): CanvasItem => ({ id, title: id, content: { kind: 'code', code: id, language: 'text' } });

test('passive results cannot open a panel, create a tab, or change selection', () => {
  assert.equal(canvasSelection(emptyCanvas, { type: 'update', id: 'new', patch: { title: 'Arrived' } }), emptyCanvas);
  let state = canvasSelection(emptyCanvas, { type: 'show', item: item('first') });
  state = canvasSelection(state, { type: 'show', item: item('second') });
  state = canvasSelection(state, { type: 'select', id: 'first' });
  state = canvasSelection(state, { type: 'update', id: 'second', patch: { title: 'Updated' } });
  assert.equal(state.activeId, 'first');
  assert.equal(state.items[1]?.title, 'Updated');
  state = canvasSelection(state, { type: 'visibility', open: false });
  state = canvasSelection(state, { type: 'update', id: 'first', patch: { title: 'Refreshed' } });
  assert.equal(state.open, false);
  assert.equal(state.activeId, 'first');
});

test('closed results stay closed until explicitly opened and the final close hides the panel', () => {
  let state = canvasSelection(emptyCanvas, { type: 'show', item: item('first') });
  state = canvasSelection(state, { type: 'show', item: item('second') });
  state = canvasSelection(state, { type: 'close', id: 'second' });
  assert.equal(state.activeId, 'first');
  assert.equal(state.open, true);
  state = canvasSelection(state, { type: 'update', id: 'second', patch: { title: 'Later update' } });
  assert.equal(state.items.length, 1);
  state = canvasSelection(state, { type: 'close', id: 'first' });
  assert.deepEqual(state, emptyCanvas);
  assert.deepEqual(canvasSelection(state, { type: 'visibility', open: true }), emptyCanvas);
  state = canvasSelection(state, { type: 'show', item: item('second') });
  assert.equal(state.activeId, 'second');
  assert.equal(state.open, true);
});

test('reopening an existing result does not duplicate it', () => {
  let state = canvasSelection(emptyCanvas, { type: 'show', item: item('first') });
  state = canvasSelection(state, { type: 'show', item: { ...item('first'), title: 'New title' } });
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0]?.title, 'New title');
});
