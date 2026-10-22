import * as THREE from 'three';
import type { TulipAvatarState } from './catalog.ts';
type HandPose = [number, number, number, number, number];

export function createPortraitActions(
  root: THREE.Object3D,
  keyboard: THREE.Group,
  book: THREE.Group,
  hands: THREE.Group[],
) {
  const group = new THREE.Group();
  const portraitKeyboard = keyboard.clone(true);
  portraitKeyboard.position.set(0, 1.39, 0.94);
  const portraitBook = book.clone(true);
  portraitBook.position.set(0, 1.43, 0.93);
  const portraitHands = hands.map(hand => hand.clone(true));
  group.add(portraitKeyboard, portraitBook, ...portraitHands);
  group.traverse(object => object.layers.set(1));
  portraitKeyboard.visible = false;
  portraitBook.visible = false;
  portraitHands.forEach(hand => {
    hand.visible = false;
  });
  root.add(group);
  return { keyboard: portraitKeyboard, book: portraitBook, hands: portraitHands };
}

function poseHand(hand: THREE.Group, pose: HandPose | undefined, dt: number) {
  const previouslyVisible = hand.visible;
  hand.visible = pose !== undefined;
  if (!pose) return;
  const [x, y, z, rx, rz] = pose;
  const blend = (from: number, to: number) => (previouslyVisible ? THREE.MathUtils.damp(from, to, 14, dt) : to);
  hand.position.set(blend(hand.position.x, x), blend(hand.position.y, y), blend(hand.position.z, z));
  hand.rotation.set(blend(hand.rotation.x, rx), 0, blend(hand.rotation.z, rz));
}

export function updatePortraitActions(
  rig: ReturnType<typeof createPortraitActions>,
  action: TulipAvatarState,
  time: number,
  phase: number,
  dt: number,
) {
  rig.keyboard.visible = action === 'Working';
  rig.book.visible = action === 'Reading';
  let left: HandPose | undefined;
  let right: HandPose | undefined;
  if (action === 'Working') {
    const tap = Math.sin(time * 13) * 0.045;
    left = [-0.39, 1.58 + tap, 1.04, -0.25, -0.08];
    right = [0.39, 1.58 - tap, 1.04, -0.25, 0.08];
    rig.keyboard.children.slice(1).forEach((key, i) => {
      key.position.y = 0.047 - Math.max(0, Math.sin(time * 13 + i * 1.7)) * 0.015;
    });
  } else if (action === 'Reading') {
    left = [-0.49, 1.48, 0.92, -0.1, -0.7];
    right = [0.49, 1.48, 0.92, -0.1, 0.7];
  } else if (action === 'Waving') {
    right = [1.02, 2.06 + Math.sin(time * 4) * 0.035, 0.72, -0.12, 2.8 + Math.sin(time * 9) * 0.3];
  } else if (action === 'Celebrating' || (action === 'Solving' && phase >= 3.5)) {
    const bounce = Math.max(0, Math.sin(time * 3)) * 0.08;
    left = [-0.99, 2.12 + bounce, 0.7, -0.1, -2.8 + Math.sin(time * 6) * 0.12];
    right = [0.99, 2.12 + bounce, 0.7, -0.1, 2.8 - Math.sin(time * 6) * 0.12];
  } else if (action === 'Thinking' || action === 'Solving') {
    right = [0.67, 1.85, 0.81, -0.12, 2.55];
  } else if (action === 'Listening') {
    right = [1.01, 2.01, 0.68, -0.1, 2.95];
  } else if (action === 'Confused') {
    const lift = Math.sin(time * 2.4) * 0.06;
    left = [-0.98, 1.82 + lift, 0.68, -0.3, -1.75];
    right = [0.98, 1.82 + lift, 0.68, -0.3, 1.75];
  }
  poseHand(rig.hands[0]!, left, dt);
  poseHand(rig.hands[1]!, right, dt);
}
