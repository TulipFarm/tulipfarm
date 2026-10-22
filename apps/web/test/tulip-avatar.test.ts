import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  resolveAvatarColor,
  tulipAvatarCharacters,
  tulipAvatarColors,
  tulipAvatarStates,
  validateAvatarOptions,
} from '../src/components/tulip-avatar/catalog.ts';
import { createPortraitActions, updatePortraitActions } from '../src/components/tulip-avatar/portrait-actions.ts';

test('the approved catalog has 16 characters, 12 colors and 14 states', () => {
  assert.equal(new Set(tulipAvatarCharacters).size, 16);
  assert.equal(new Set(Object.values(tulipAvatarColors)).size, 12);
  assert.equal(new Set(tulipAvatarStates).size, 14);
  for (const character of tulipAvatarCharacters) {
    for (const state of tulipAvatarStates) {
      validateAvatarOptions({ character, state, color: 'Blue', view: 'head', paused: false });
    }
  }
  for (const [name, color] of Object.entries(tulipAvatarColors)) {
    assert.equal(resolveAvatarColor(name as keyof typeof tulipAvatarColors), color);
  }
  assert.equal(resolveAvatarColor('#123abc'), '#123abc');
  assert.throws(() => resolveAvatarColor('#invalid'), /Invalid avatar color/);
  assert.throws(() => resolveAvatarColor('#fff'), /Invalid avatar color/);
});

function fixture() {
  const root = new THREE.Group();
  const keyboard = new THREE.Group();
  const book = new THREE.Group();
  const hands: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  for (const group of [keyboard, book, ...hands]) {
    group.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial()));
    group.position.set(0.2, 0.9, 0.6);
  }
  const key = keyboard.children[0]!.clone();
  key.position.y = 0.047;
  keyboard.add(key);
  return { root, keyboard, book, hands, rig: createPortraitActions(root, keyboard, book, hands) };
}

test('portrait props use only the head layer and leave full-body originals unchanged', () => {
  const { root, keyboard, book, hands, rig } = fixture();
  root.traverse(object => {
    if (object !== root) assert.equal(object.layers.mask, 2);
  });
  for (const state of tulipAvatarStates) updatePortraitActions(rig, state, 1.2, 1.2, 0.1);
  for (const original of [keyboard, book, ...hands]) {
    assert.deepEqual(original.position.toArray(), [0.2, 0.9, 0.6]);
    assert.deepEqual(original.rotation.toArray(), [0, 0, 0, 'XYZ']);
    original.traverse(object => assert.equal(object.layers.mask, 1));
  }
  assert.equal(keyboard.children[1]!.position.y, 0.047);
});

test('state changes show the right head props and remove old ones', () => {
  const { rig } = fixture();
  for (const state of tulipAvatarStates) {
    updatePortraitActions(rig, 'Working', 0, 0, 1);
    updatePortraitActions(rig, state, 1, 1, 1);
    assert.equal(rig.keyboard.visible, state === 'Working', state);
    assert.equal(rig.book.visible, state === 'Reading', state);
    assert.equal(rig.hands[0]!.visible, ['Working', 'Reading', 'Confused', 'Celebrating'].includes(state), state);
    assert.equal(
      rig.hands[1]!.visible,
      ['Working', 'Reading', 'Confused', 'Celebrating', 'Waving', 'Thinking', 'Solving', 'Listening'].includes(state),
      state,
    );
  }
  updatePortraitActions(rig, 'Solving', 4, 4, 1);
  assert.ok(rig.hands.every(hand => hand.visible));
});

test('typing and waving move without mutating a second avatar', () => {
  const { rig } = fixture();
  const other = fixture().rig;
  updatePortraitActions(other, 'Sleeping', 0, 0, 1);
  updatePortraitActions(rig, 'Working', 0, 0, 1);
  const initial = rig.hands.map(hand => hand.position.y);
  updatePortraitActions(rig, 'Working', 0.1, 0.1, 1);
  assert.ok(rig.hands[0]!.position.y > initial[0]!);
  assert.ok(rig.hands[1]!.position.y < initial[1]!);
  updatePortraitActions(rig, 'Waving', 0, 0, 1);
  const wrist = rig.hands[1]!.rotation.z;
  updatePortraitActions(rig, 'Waving', 0.1, 0.1, 1);
  assert.notEqual(rig.hands[1]!.rotation.z, wrist);
  assert.ok(other.hands.every(hand => !hand.visible));
  assert.equal(other.keyboard.visible, false);
});
