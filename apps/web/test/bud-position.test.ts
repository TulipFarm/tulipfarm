import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBudCorner, nearestBudCorner } from '../src/features/chat/bud-position.ts';

test('Bud accepts only four corners and snaps each screen quadrant inward', () => {
  for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'])
    assert.equal(isBudCorner(corner), true);
  for (const value of [null, '', 'center', '__proto__', {}, 3]) assert.equal(isBudCorner(value), false);
  assert.equal(nearestBudCorner(20, 20, 390, 844), 'top-left');
  assert.equal(nearestBudCorner(370, 20, 390, 844), 'top-right');
  assert.equal(nearestBudCorner(20, 800, 390, 844), 'bottom-left');
  assert.equal(nearestBudCorner(370, 800, 390, 844), 'bottom-right');
});
