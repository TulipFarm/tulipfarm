import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createIndicators, updateIndicators } from './indicators.ts';
import { createPortraitActions, updatePortraitActions } from './portrait-actions.ts';
import type { TulipAvatarCharacter, TulipAvatarState } from './catalog.ts';

function ellipsoid(
  parent: THREE.Object3D,
  material: THREE.Material,
  position: [number, number, number],
  scale: [number, number, number],
) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), material);
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function petalGeometry(height: number, width: number, bend: number, curl = 0, roundness = 0.85) {
  const points = [];
  for (let i = 0; i <= 28; i++) {
    const t = i / 28;
    points.push(new THREE.Vector2(Math.pow(Math.sin(Math.PI * t), roundness) * width + 0.002, t * height));
  }
  const geometry = new THREE.LatheGeometry(points, 40);
  const positions = geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    const t = positions.getY(i) / height;
    positions.setX(i, positions.getX(i) + bend * t * t + curl * Math.sin(t * Math.PI * 0.8));
    positions.setY(i, positions.getY(i) - Math.abs(curl) * t ** 5 * 0.18);
    positions.setZ(i, positions.getZ(i) * 0.57 + Math.abs(curl) * t ** 3 * 0.35);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function createAvatarModel(scene: THREE.Scene, character: TulipAvatarCharacter, color: string) {
  const variant = character.toLowerCase();
  const fill = new THREE.HemisphereLight(0xecfaff, 0x607969, 1.2);
  fill.layers.enable(1);
  scene.add(fill);
  const key = new THREE.DirectionalLight(0xfff6e8, 3);
  key.position.set(-3, 6, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -3;
  key.shadow.camera.right = 3;
  key.shadow.camera.top = 5;
  key.shadow.camera.bottom = -3;
  key.shadow.normalBias = 0.035;
  key.shadow.bias = -0.0002;
  key.shadow.radius = 4;
  key.layers.enable(1);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xdbedff, 2);
  rim.position.set(3, 3, -3);
  rim.layers.enable(1);
  scene.add(rim);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: 0.16 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.position.y = 0.015;
  scene.add(floor);
  const material = new THREE.MeshPhysicalMaterial({
    color: color,
    roughness: 1,
    metalness: 0,
    clearcoat: 0,
    specularIntensity: 0,
  });
  const black = new THREE.MeshPhysicalMaterial({ color: 0x10202b, roughness: 1, specularIntensity: 0 });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const root = new THREE.Group();
  scene.add(root);
  root.rotation.y = -0.14;
  const body = new THREE.Group();
  root.add(body);
  ellipsoid(body, material, [0, 0.97, 0], [0.53, 0.61, 0.39]);
  ellipsoid(body, material, [0, 1.4, 0], [0.3, 0.28, 0.29]);
  for (const side of [-1, 1]) {
    ellipsoid(root, material, [side * 0.25, 0.34, 0], [0.18, 0.31, 0.19]);
    ellipsoid(root, material, [side * 0.26, 0.14, 0.105], [0.24, 0.14, 0.32]);
  }
  const head = new THREE.Group();
  head.position.y = variant === 'pip' ? 1.98 : 2.08;
  body.add(head);
  const face = new THREE.Mesh(new RoundedBoxGeometry(1.64, 1.36, 1.24, 8, 0.49), material);
  face.castShadow = true;
  face.receiveShadow = true;
  head.add(face);
  if (variant === 'pip') head.scale.setScalar(1.08);
  const petalConfigs: Record<string, [number, number, number, number, number, number, number, number?, number?][]> = {
    bud: [
      [-0.52, 0.32, 0, 1.05, 0.37, -0.13, -0.12],
      [0.06, 0.35, -0.12, 1.43, 0.42, 0.2, 0],
      [0.53, 0.32, 0.04, 1.07, 0.36, 0.18, 0.1],
    ],
    bloom: [
      [-0.56, 0.26, 0, 1.08, 0.42, -0.4, 0.1],
      [0.53, 0.26, 0, 1.08, 0.42, 0.4, -0.1],
      [-0.3, 0.42, -0.28, 1.05, 0.36, -0.1, 0],
      [0.3, 0.42, -0.28, 1.05, 0.36, 0.1, 0],
      [0, 0.35, 0.16, 1.26, 0.43, 0, 0],
    ],
    swoop: [
      [-0.51, 0.3, 0, 1.08, 0.38, 0.24, -0.15],
      [0, 0.35, 0.04, 1.48, 0.46, 0.53, -0.05],
      [0.54, 0.3, -0.07, 0.94, 0.35, 0.38, 0],
    ],
    pip: [
      [-0.47, 0.3, 0.01, 0.86, 0.36, -0.14, 0],
      [0, 0.36, -0.08, 1.19, 0.41, 0.05, 0],
      [0.48, 0.3, 0.02, 0.86, 0.36, 0.15, 0],
    ],
    curl: [
      [-0.54, 0.35, -0.04, 0.67, 0.34, 0.05, -0.5, 0, 0.5],
      [-0.35, 0.65, -0.1, 0.83, 0.43, -0.08, -0.9, 0.07, 0.45],
      [0.05, 0.77, 0.08, 0.72, 0.36, -0.15, -1.5, -0.1, 0.5],
    ],
    fan: [
      [-0.48, 0.35, -0.06, 0.74, 0.47, -0.14, 0.2, 0, 0.45],
      [0, 0.4, -0.16, 0.91, 0.48, 0, 0, 0, 0.45],
      [0.48, 0.35, -0.04, 0.74, 0.47, 0.14, -0.2, 0, 0.45],
    ],
    twin: [
      [-0.35, 0.28, -0.02, 1.4, 0.52, -0.29, 0, 0.16],
      [0.37, 0.28, 0.04, 1.23, 0.52, 0.24, 0, -0.12],
    ],
    fringe: [
      [-0.5, 0.3, -0.2, 0.91, 0.37, -0.11, 0],
      [0.04, 0.4, -0.25, 1.32, 0.42, 0.18, 0],
      [0.5, 0.3, -0.18, 0.99, 0.34, 0.2, 0],
      [-0.42, 0.65, 0.43, 0.97, 0.28, 0.16, -1.67, 0.12],
      [-0.25, 0.73, 0.27, 1.02, 0.27, 0.12, -1.3],
    ],
    dew: [
      [0, 0.3, 0, 1.15, 0.63, 0.04, 0, 0, 0.65],
      [-0.52, 0.3, -0.08, 0.5, 0.3, -0.1, 0.3],
      [0.52, 0.3, -0.08, 0.5, 0.3, 0.1, -0.3],
    ],
    clover: [
      [-0.45, 0.38, 0, 0.7, 0.4, -0.05, 0.35, 0, 0.35],
      [0.02, 0.55, -0.15, 0.85, 0.42, 0, 0, 0, 0.35],
      [0.45, 0.38, 0, 0.7, 0.4, 0.05, -0.35, 0, 0.35],
    ],
    ribbon: [
      [-0.55, 0.38, 0.07, 1.31, 0.31, 0.1, -0.8, 0.05],
      [0.5, 0.38, -0.1, 1.26, 0.33, -0.1, 0.75, -0.05],
    ],
    floret: [
      [-0.35, 0.43, -0.18, 0.85, 0.38, -0.12, 0.1],
      [0.35, 0.43, -0.18, 0.85, 0.38, 0.12, -0.1],
      [-0.4, 0.35, 0.2, 0.68, 0.4, 0.06, -0.45],
      [0.4, 0.35, 0.2, 0.68, 0.4, -0.06, 0.45],
    ],
    wisp: [
      [-0.15, 0.38, -0.06, 1.32, 0.32, -0.36, 0.1],
      [0.3, 0.36, 0.05, 1.0, 0.3, -0.34, 0.05],
      [-0.53, 0.33, 0.01, 0.53, 0.27, -0.2, 0.1],
    ],
    bramble: [
      [-0.48, 0.32, -0.06, 0.73, 0.44, -0.2, 0.1],
      [0.08, 0.35, -0.08, 1.08, 0.5, -0.23, 0.1],
      [0.51, 0.3, 0.13, 0.53, 0.35, 0.24, -0.1],
    ],
    lotus: [
      [-0.6, 0.33, -0.08, 0.65, 0.43, -0.24, 0.2, 0, 0.5],
      [0.6, 0.33, -0.08, 0.65, 0.43, 0.24, -0.2, 0, 0.5],
      [0, 0.4, -0.19, 0.95, 0.38, 0, 0],
      [-0.3, 0.36, 0.24, 0.6, 0.34, 0.02, -0.45],
      [0.3, 0.36, 0.24, 0.6, 0.34, -0.02, 0.45],
    ],
    sprig: [
      [-0.29, 0.33, -0.04, 1.23, 0.4, -0.26, 0.05],
      [0.39, 0.34, 0.06, 0.75, 0.44, 0.32, -0.28],
      [-0.01, 0.37, 0.24, 0.47, 0.3, 0.1, -0.25],
    ],
  };
  const petals = [];
  const hair = new THREE.Group();
  hair.position.y = 0.3;
  hair.scale.setScalar(0.9);
  head.add(hair);
  for (const [x, y, z, height, width, bend, rotation, curl, roundness] of petalConfigs[variant]!) {
    const petal = new THREE.Mesh(petalGeometry(height, width, bend, curl, roundness), material);
    petal.position.set(x, y - 0.3, z);
    petal.rotation.z = rotation;
    petal.castShadow = true;
    petal.receiveShadow = true;
    hair.add(petal);
    petals.push(petal);
  }
  const eyes = [];
  for (const side of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(side * 0.3, -0.1, 0.606);
    const eyeShape = new THREE.Group();
    eyeShape.scale.setScalar(1.2);
    eye.add(eyeShape);
    ellipsoid(eyeShape, black, [0, 0, 0], [0.079, 0.145, 0.05]);
    ellipsoid(eyeShape, white, [-0.02, 0.055, 0.045], [0.022, 0.026, 0.009]);
    head.add(eye);
    eyes.push(eye);
  }
  head.traverse(object => object.layers.enable(1));
  const arms = [];
  const elbows = [];
  const hands = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(side * 0.47, 1.35, 0);
    ellipsoid(arm, material, [0, -0.13, 0], [0.165, 0.235, 0.18]);
    const elbow = new THREE.Group();
    elbow.position.y = -0.27;
    arm.add(elbow);
    ellipsoid(elbow, material, [0, -0.11, 0], [0.145, 0.21, 0.16]);
    const hand = new THREE.Group();
    hand.position.set(0, -0.31, 0.025);
    elbow.add(hand);
    ellipsoid(hand, material, [0, 0, 0], [0.18, 0.18, 0.17]);
    for (let finger = 0; finger < 3; finger++) {
      ellipsoid(hand, material, [(finger - 1) * 0.075, -0.1, 0.085], [0.049, 0.1, 0.065]);
    }
    ellipsoid(hand, material, [-side * 0.14, 0, 0.07], [0.08, 0.12, 0.09]);
    body.add(arm);
    arms.push(arm);
    elbows.push(elbow);
    hands.push(hand);
  }
  const keyboard = new THREE.Group();
  const keyboardMaterial = new THREE.MeshStandardMaterial({ color: 0xf4f7f5, roughness: 0.6 });
  const board = new THREE.Mesh(new RoundedBoxGeometry(0.98, 0.065, 0.43, 3, 0.025), keyboardMaterial);
  keyboard.add(board);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 8; col++) {
      const keycap = new THREE.Mesh(new RoundedBoxGeometry(0.083, 0.035, 0.075, 2, 0.012), keyboardMaterial);
      keycap.position.set((col - 3.5) * 0.112, 0.047, (row - 1) * 0.115);
      keyboard.add(keycap);
    }
  }
  keyboard.position.set(0, 0.95, 0.64);
  keyboard.rotation.x = 0.15;
  root.add(keyboard);
  const book = new THREE.Group();
  const coverMaterial = new THREE.MeshPhysicalMaterial({ color: 0x447b68, roughness: 1, specularIntensity: 0 });
  const paperMaterial = new THREE.MeshPhysicalMaterial({ color: 0xf6f1df, roughness: 1, specularIntensity: 0 });
  for (const side of [-1, 1]) {
    const half = new THREE.Group();
    half.position.x = side * 0.23;
    half.rotation.z = side * -0.12;
    const cover = new THREE.Mesh(new RoundedBoxGeometry(0.47, 0.055, 0.57, 2, 0.025), coverMaterial);
    half.add(cover);
    const pages = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.045, 0.52, 2, 0.014), paperMaterial);
    pages.position.y = 0.05;
    half.add(pages);
    book.add(half);
  }
  book.position.set(0, 1.04, 0.61);
  book.rotation.x = 0.28;
  root.add(book);
  const portraitActions = createPortraitActions(root, keyboard, book, hands);
  const idea = new THREE.Group();
  const ideaMaterial = new THREE.MeshBasicMaterial({ color: 0xffcd51 });
  ellipsoid(idea, ideaMaterial, [0, 0, 0], [0.15, 0.18, 0.15]);
  ellipsoid(idea, keyboardMaterial, [0, -0.17, 0], [0.07, 0.055, 0.07]);
  for (let i = 0; i < 5; i++) {
    const angle = (i * Math.PI) / 4;
    const ray = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.08, 4, 8), ideaMaterial);
    ray.position.set(Math.cos(angle) * 0.29, Math.sin(angle) * 0.31, 0);
    ray.rotation.z = angle - Math.PI / 2;
    idea.add(ray);
  }
  idea.position.set(0.95, 3.65, 0);
  idea.traverse(object => object.layers.enable(1));
  root.add(idea);
  const indicators = createIndicators(root);

  return {
    scene,
    root,
    body,
    head,
    hair,
    eyes,
    arms,
    elbows,
    hands,
    petals,
    keyboard,
    book,
    idea,
    indicators,
    portraitActions,
    material,
  };
}
export type AvatarModel = ReturnType<typeof createAvatarModel>;
const damp = (current: number, target: number, dt: number) => THREE.MathUtils.damp(current, target, 10, dt);
export function animateAvatar(avatar: AvatarModel, action: TulipAvatarState, time: number, dt: number) {
  const { root, body, head, eyes, arms, elbows, hands, petals, keyboard, book, idea } = avatar;
  const t = time;
  const breath = Math.sin(t * 1.55);
  const solvingPhase = time % 7;
  const thinking = action === 'Thinking' || (action === 'Solving' && solvingPhase < 3.5);
  const solved = action === 'Solving' && solvingPhase >= 3.5;
  const anticipation = action === 'Solving' && solvingPhase >= 2.8 && solvingPhase < 3.5;
  const working = action === 'Working';
  const waving = action === 'Waving';
  const listening = action === 'Listening';
  const breathing = action === 'Breathing';
  const reading = action === 'Reading';
  const searching = action === 'Searching';
  const sleeping = action === 'Sleeping';
  const nodding = action === 'Nodding';
  const confused = action === 'Confused';
  const celebrating = action === 'Celebrating';
  const joyful = solved || celebrating;
  const blinkPeriod = action === 'Blinking' ? 2.5 : 4.7;
  const blinkTime = t % blinkPeriod;
  const blink =
    Math.exp(-Math.pow((blinkTime - 0.22) / 0.07, 2)) +
    (action === 'Blinking' ? Math.exp(-Math.pow((blinkTime - 0.55) / 0.07, 2)) : 0);
  const hop = celebrating
    ? Math.max(0, Math.sin(t * 3))
    : solved
      ? Math.max(0, Math.sin(Math.min((solvingPhase - 3.5) * 4.5, Math.PI)))
      : 0;
  const inhale = sleeping ? Math.sin(t * 0.9) : breath;
  body.scale.y = damp(
    body.scale.y,
    anticipation ? 0.94 : 1 + inhale * (breathing || sleeping ? 0.047 : 0.009) + hop * 0.025,
    dt,
  );
  body.scale.x = damp(
    body.scale.x,
    anticipation ? 1.04 : 1 + inhale * (breathing || sleeping ? 0.027 : 0.004) - hop * 0.015,
    dt,
  );
  root.position.y = damp(root.position.y, waving ? Math.max(0, Math.sin(t * 4)) * 0.035 : hop * 0.24, dt);
  root.rotation.z = damp(
    root.rotation.z,
    waving ? Math.sin(t * 4) * 0.04 : listening ? -0.035 : Math.sin(t * 1.1) * 0.021,
    dt,
  );
  head.rotation.z = damp(
    head.rotation.z,
    thinking ? -0.15 + Math.sin(t * 1.4) * 0.02 : listening ? 0.18 : waving ? -0.08 : Math.sin(t * 0.8) * 0.035,
    dt,
  );
  head.rotation.x = damp(
    head.rotation.x,
    anticipation
      ? 0.18
      : thinking
        ? -0.13
        : working
          ? 0.22 + Math.sin(t * 2) * 0.025
          : listening
            ? 0.04 + Math.pow(Math.max(0, Math.sin(t * 1.8)), 4) * 0.12
            : solved
              ? -0.09
              : Math.sin(t) * 0.022,
    dt,
  );
  head.rotation.y = damp(
    head.rotation.y,
    thinking ? -0.14 : action === 'Idle' ? Math.sin(t * 0.6) * 0.13 : listening ? -0.1 : 0,
    dt,
  );
  if (sleeping) {
    head.rotation.z = damp(head.rotation.z, 0.22, dt * 3);
    head.rotation.x = damp(head.rotation.x, 0.16 + inhale * 0.03, dt * 3);
  } else if (reading) {
    head.rotation.x = damp(head.rotation.x, 0.23, dt * 3);
    head.rotation.y = damp(head.rotation.y, Math.sin(t * 1.8) * 0.1, dt * 3);
  } else if (searching) {
    head.rotation.y = damp(head.rotation.y, Math.sin(t * 1.35) * 0.38, dt * 3);
    head.rotation.x = damp(head.rotation.x, -0.06 + Math.sin(t * 2.7) * 0.07, dt * 3);
  } else if (nodding) {
    const nod = Math.max(0, Math.sin((t % 4) * Math.PI));
    head.rotation.x = damp(head.rotation.x, nod * 0.28 - 0.06, dt * 3);
  } else if (confused) {
    head.rotation.z = damp(head.rotation.z, Math.sin(t * 1.6) * 0.23, dt * 3);
    head.rotation.y = damp(head.rotation.y, Math.sin(t * 0.8) * 0.08, dt * 3);
  } else if (celebrating) {
    head.rotation.z = damp(head.rotation.z, Math.sin(t * 4) * 0.13, dt * 3);
    head.rotation.x = damp(head.rotation.x, -0.12, dt * 3);
  } else if (waving) {
    head.rotation.z = damp(head.rotation.z, Math.sin(t * 5) * 0.12, dt * 3);
  }
  for (const [i, eye] of eyes.entries()) {
    eye.scale.y = damp(
      eye.scale.y,
      sleeping
        ? 0.055
        : Math.max(0.06, 1 - blink * 0.96) * (joyful ? 0.65 : confused ? (i === 0 ? 0.6 : 1.1) : listening ? 1.06 : 1),
      dt * 4,
    );
    eye.position.y = damp(eye.position.y, thinking ? -0.025 : -0.1, dt);
    eye.position.x = damp(
      eye.position.x,
      (i === 0 ? -0.3 : 0.3) + (reading ? Math.sin(t * 1.8) * 0.035 : searching ? Math.sin(t * 1.35) * 0.04 : 0),
      dt,
    );
  }
  arms[0]!.rotation.z = damp(
    arms[0]!.rotation.z,
    joyful ? -2.05 : confused ? -0.85 : working || reading ? -0.25 : -0.13 + Math.sin(t * 1.55) * 0.045,
    dt,
  );
  arms[1]!.rotation.z = damp(
    arms[1]!.rotation.z,
    waving
      ? 1.9 + Math.sin(t * 6) * 0.08
      : thinking
        ? 1.65
        : joyful
          ? 2.05
          : listening
            ? 1.5
            : confused
              ? 0.85
              : working || reading
                ? 0.25
                : 0.13 - Math.sin(t * 1.55) * 0.045,
    dt,
  );
  arms[0]!.rotation.x = damp(arms[0]!.rotation.x, working || reading ? -0.55 : joyful ? -0.2 : 0, dt);
  arms[1]!.rotation.x = damp(
    arms[1]!.rotation.x,
    working || reading ? -0.55 : thinking ? -0.6 : waving ? -0.25 : listening ? 0.12 : 0,
    dt,
  );
  elbows[0]!.rotation.x = damp(
    elbows[0]!.rotation.x,
    working ? -0.8 + Math.sin(t * 13) * 0.17 : reading || confused ? -0.9 : -0.1,
    dt,
  );
  elbows[1]!.rotation.x = damp(
    elbows[1]!.rotation.x,
    working ? -0.8 + Math.sin(t * 13 + Math.PI) * 0.17 : reading || confused ? -0.9 : thinking ? -0.3 : -0.1,
    dt,
  );
  elbows[0]!.rotation.z = damp(elbows[0]!.rotation.z, joyful ? -0.2 : 0.08, dt);
  elbows[1]!.rotation.z = damp(
    elbows[1]!.rotation.z,
    waving ? 0.55 + Math.sin(t * 7) * 0.2 : thinking ? 1.15 : listening ? 1.25 : joyful ? 0.2 : -0.08,
    dt,
  );
  hands[1]!.rotation.z = damp(
    hands[1]!.rotation.z,
    waving ? Math.sin(t * 9) * 0.3 : thinking ? -0.25 : listening ? 0.2 : 0,
    dt,
  );
  hands.forEach((hand, i) => {
    hand.rotation.x = damp(hand.rotation.x, working ? 0.25 + Math.sin(t * 13 + i * Math.PI) * 0.16 : 0, dt);
  });
  petals.forEach((petal, i) => {
    petal.rotation.x =
      inhale * (breathing || sleeping ? 0.045 : 0.01) + (waving || celebrating ? Math.sin(t * 4 - i * 0.4) * 0.045 : 0);
  });
  keyboard.visible = working;
  book.visible = reading;
  const ideaReady = action === 'Solving' && solvingPhase >= 0.9;
  idea.visible = ideaReady;
  idea.scale.setScalar(ideaReady ? Math.min(1, 0.3 + (solvingPhase - 0.9) * 4) : 0);
  idea.rotation.y = Math.sin(t * 2) * 0.18;
  updateIndicators(avatar.indicators, action, time);
  updatePortraitActions(avatar.portraitActions, action, t, solvingPhase, dt);
}
