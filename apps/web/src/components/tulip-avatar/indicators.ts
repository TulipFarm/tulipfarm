import * as THREE from 'three';
import type { TulipAvatarState } from './catalog.ts';

function glyph(text: string, color: string, emoji = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 192;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not draw animation symbols');
  context.font = emoji ? '112px "Apple Color Emoji", "Segoe UI Emoji", sans-serif' : 'bold 112px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.lineWidth = 12;
  context.strokeStyle = '#fffdf6';
  context.fillStyle = color;
  if (!emoji) context.strokeText(text, 96, 104);
  context.fillText(text, 96, 104);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false }));
  sprite.scale.setScalar(0.46);
  return sprite;
}

function ball(
  parent: THREE.Object3D,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 16), material);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  parent.add(mesh);
  return mesh;
}

export function createIndicators(root: THREE.Object3D) {
  const groups = {
    thought: new THREE.Group(),
    math: new THREE.Group(),
    listening: new THREE.Group(),
    search: new THREE.Group(),
    sleep: new THREE.Group(),
    confused: new THREE.Group(),
    celebrate: new THREE.Group(),
  };
  const ink = new THREE.MeshBasicMaterial({ color: 0x245a72 });
  const paper = new THREE.MeshBasicMaterial({ color: 0xfffdf6 });
  const teal = new THREE.MeshBasicMaterial({ color: 0x24785e });
  const bubble = groups.thought;
  bubble.position.set(0.83, 3.55, 0.65);
  ball(bubble, paper, 0, 0, 0, 0.36, 0.23, 0.08);
  ball(bubble, paper, -0.2, -0.25, 0, 0.067, 0.057, 0.045);
  ball(bubble, paper, -0.31, -0.37, 0, 0.035, 0.035, 0.03);
  const dots = [-0.15, 0, 0.15].map(x => ball(bubble, ink, x, 0, 0.085, 0.045, 0.045, 0.025));
  const math = ['+', '=', '\u221a', 'x\u00b2'].map(text => {
    const sprite = glyph(text, '#246f97');
    groups.math.add(sprite);
    return sprite;
  });
  const listening = groups.listening;
  listening.position.set(0.93, 2.27, 0.5);
  ball(listening, teal, 0, -0.13, 0, 0.095, 0.21, 0.09);
  const bars = Array.from({ length: 4 }, (_, index) => {
    const bar = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.22, 4, 8), teal);
    bar.position.set(0.17 + index * 0.09, 0.12, 0);
    listening.add(bar);
    return bar;
  });
  const search = groups.search;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.04, 12, 40), ink);
  search.add(rim);
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.21, 32),
    new THREE.MeshBasicMaterial({
      color: 0xc7eff9,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  search.add(lens);
  const handle = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.27, 5, 12), ink);
  handle.position.set(0.24, -0.27, 0);
  handle.rotation.z = 0.68;
  search.add(handle);
  const sleep = Array.from({ length: 3 }, () => {
    const sprite = glyph('Z', '#6263a6');
    groups.sleep.add(sprite);
    return sprite;
  });
  const questions = ['?', '?'].map(text => {
    const sprite = glyph(text, '#a36429');
    groups.confused.add(sprite);
    return sprite;
  });
  const party = ['🎉', '🎊'].map(text => {
    const sprite = glyph(text, '#d58e33', true);
    sprite.scale.setScalar(0.68);
    groups.celebrate.add(sprite);
    return sprite;
  });
  const confetti = Array.from({ length: 16 }, (_, i) => {
    const material = new THREE.MeshBasicMaterial({
      color: [0xe46b97, 0xeebf48, 0x62bdab, 0x8a86d6][i % 4]!,
      side: THREE.DoubleSide,
      transparent: true,
    });
    const piece = new THREE.Mesh(new THREE.PlaneGeometry(0.037, 0.075), material);
    groups.celebrate.add(piece);
    return piece;
  });
  for (const group of Object.values(groups)) {
    group.traverse(object => object.layers.enable(1));
    group.visible = false;
    root.add(group);
  }
  return { groups, dots, math, bars, sleep, questions, party, confetti };
}

export function updateIndicators(
  indicators: ReturnType<typeof createIndicators>,
  action: TulipAvatarState,
  time: number,
) {
  const { groups, dots, math, bars, sleep, questions, party, confetti } = indicators;
  groups.thought.visible = action === 'Thinking';
  groups.math.visible = action === 'Solving';
  groups.listening.visible = action === 'Listening';
  groups.search.visible = action === 'Searching';
  groups.sleep.visible = action === 'Sleeping';
  groups.confused.visible = action === 'Confused';
  groups.celebrate.visible = action === 'Celebrating';
  dots.forEach((dot, i) => {
    const pulse = 1 + Math.sin(time * 5 - i * 1.3) * 0.3;
    dot.scale.set(0.045 * pulse, 0.045 * pulse, 0.025);
  });
  math.forEach((sprite, i) => {
    const phase = (time * 0.35 + i / math.length) % 1;
    sprite.position.set(-1.08 + i * 0.48, 3.17 + phase * 0.78, 0.7);
    sprite.material.opacity = 0.65 + Math.sin(phase * Math.PI) * 0.35;
    sprite.material.rotation = Math.sin(time + i) * 0.12;
  });
  bars.forEach((bar, i) => {
    bar.scale.y = 0.5 + (1 + Math.sin(time * 6 - i * 0.85)) * 0.55;
  });
  groups.search.position.set(Math.sin(time * 1.9) * 0.52, 2.08 + Math.cos(time * 1.5) * 0.12, 1.03);
  groups.search.rotation.z = Math.sin(time * 1.9) * -0.15;
  sleep.forEach((sprite, i) => {
    const phase = (time * 0.26 + i / sleep.length) % 1;
    sprite.position.set(0.67 + phase * 0.35, 2.9 + phase * 0.93, 0.7);
    sprite.scale.setScalar(0.27 + phase * 0.24);
    sprite.material.opacity = 0.5 + Math.sin(phase * Math.PI) * 0.5;
    sprite.material.rotation = -0.12;
  });
  questions.forEach((sprite, i) => {
    sprite.position.set(i === 0 ? -0.93 : 0.83, 3.38 + Math.sin(time * 2 + i * 2) * 0.12, 0.7);
    sprite.scale.setScalar(i === 0 ? 0.62 : 0.4);
    sprite.material.rotation = Math.sin(time * 1.6 + i) * 0.18;
  });
  party.forEach((sprite, i) => {
    sprite.position.set(i === 0 ? -0.85 : 0.85, 3.25 + Math.sin(time * 4 + i) * 0.065, 0.75);
    sprite.material.rotation = Math.sin(time * 4 + i) * 0.15;
  });
  confetti.forEach((piece, i) => {
    const phase = (time * 0.48 + i / confetti.length) % 1;
    const side = i % 2 === 0 ? -1 : 1;
    piece.position.set(
      side * (0.72 + phase * 0.55) + Math.sin(i * 2.3) * 0.16,
      3.2 + phase * 1.2 - phase * phase * 0.85,
      0.8,
    );
    piece.rotation.set(time * 3 + i, time * 5 + i, time * 4 + i);
    piece.material.opacity = 1 - phase * 0.65;
  });
}
