import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { resolveAvatarColor, validateAvatarOptions, type AvatarOptions } from './catalog.ts';
import { animateAvatar, createAvatarModel, type AvatarModel } from './model.ts';

export interface AvatarHandle {
  update(options: AvatarOptions): void;
  dispose(): void;
}

interface Entry {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  model: AvatarModel;
  camera: THREE.PerspectiveCamera;
  options: AvatarOptions;
  time: number;
  lastTime: number | undefined;
  visible: boolean;
  dirty: boolean;
  failed: boolean;
  ready(): void;
  fail(error: Error): void;
}

const entries = new Set<Entry>();
let shared:
  | {
      renderer: THREE.WebGLRenderer;
      environment: THREE.WebGLRenderTarget;
      motion: MediaQueryList;
    }
  | undefined;
let frameId: number | undefined;

export function disposeAvatarScene(scene: THREE.Scene): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  scene.traverse(object => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
      if (object instanceof THREE.Mesh) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value);
        }
      }
    }
    if (object instanceof THREE.DirectionalLight) object.shadow.dispose();
  });
  geometries.forEach(geometry => geometry.dispose());
  textures.forEach(texture => texture.dispose());
  materials.forEach(material => material.dispose());
  scene.clear();
}

function report(entry: Entry, error: unknown): void {
  entry.failed = true;
  entry.lastTime = undefined;
  entry.fail(error instanceof Error ? error : new Error(String(error)));
}

function contextLost(event: Event): void {
  event.preventDefault();
  if (frameId !== undefined) cancelAnimationFrame(frameId);
  frameId = undefined;
  for (const entry of entries) report(entry, new Error('The avatar graphics context was lost. Retry the avatar.'));
}

function contextRestored(): void {
  for (const entry of entries) {
    entry.failed = false;
    entry.dirty = true;
  }
  schedule();
}

function visibilityChanged(): void {
  for (const entry of entries) entry.lastTime = undefined;
  schedule();
}

function getShared() {
  if (shared) {
    if (shared.renderer.getContext().isContextLost()) {
      throw new Error('The avatar graphics context is still unavailable. Retry after it recovers.');
    }
    return shared;
  }
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  const room = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  try {
    const environment = pmrem.fromScene(room, 0.04);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.domElement.addEventListener('webglcontextlost', contextLost);
    renderer.domElement.addEventListener('webglcontextrestored', contextRestored);
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    motion.addEventListener('change', visibilityChanged);
    document.addEventListener('visibilitychange', visibilityChanged);
    shared = { renderer, environment, motion };
    return shared;
  } catch (error) {
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  } finally {
    room.dispose();
    pmrem.dispose();
  }
}

function releaseShared(): void {
  if (entries.size || !shared) return;
  if (frameId !== undefined) cancelAnimationFrame(frameId);
  frameId = undefined;
  const { renderer, environment, motion } = shared;
  shared = undefined;
  motion.removeEventListener('change', visibilityChanged);
  document.removeEventListener('visibilitychange', visibilityChanged);
  renderer.domElement.removeEventListener('webglcontextlost', contextLost);
  renderer.domElement.removeEventListener('webglcontextrestored', contextRestored);
  environment.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
}

function moving(entry: Entry): boolean {
  return !entry.options.paused && !shared?.motion.matches;
}

function schedule(): void {
  if (frameId !== undefined || document.hidden) return;
  if ([...entries].some(entry => entry.visible && !entry.failed && (entry.dirty || moving(entry)))) {
    frameId = requestAnimationFrame(frame);
  }
}

function frame(now: number): void {
  frameId = undefined;
  if (!shared || document.hidden) return;
  const { renderer } = shared;
  for (const entry of entries) {
    if (!entry.visible || entry.failed || (!entry.dirty && !moving(entry))) {
      entry.lastTime = undefined;
      continue;
    }
    try {
      const { width, height } = entry.canvas.getBoundingClientRect();
      if (!width || !height) {
        entry.visible = false;
        continue;
      }
      if (moving(entry)) {
        const dt = entry.lastTime === undefined ? 0 : Math.min((now - entry.lastTime) / 1000, 0.05);
        entry.time += dt;
        animateAvatar(entry.model, entry.options.state, entry.time, dt);
        entry.lastTime = now;
      } else {
        entry.lastTime = undefined;
      }
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const pixels = Math.max(1, Math.round(width * ratio));
      const rows = Math.max(1, Math.round(height * ratio));
      if (renderer.domElement.width !== pixels || renderer.domElement.height !== rows)
        renderer.setSize(pixels, rows, false);
      if (entry.canvas.width !== pixels) entry.canvas.width = pixels;
      if (entry.canvas.height !== rows) entry.canvas.height = rows;
      entry.camera.aspect = width / height;
      entry.camera.updateProjectionMatrix();
      renderer.render(entry.model.scene, entry.camera);
      entry.context.clearRect(0, 0, pixels, rows);
      entry.context.drawImage(renderer.domElement, 0, 0);
      if (entry.dirty) entry.ready();
      entry.dirty = false;
    } catch (error) {
      report(entry, error);
    }
  }
  schedule();
}

function makeModel(options: AvatarOptions): AvatarModel {
  const { environment } = getShared();
  const scene = new THREE.Scene();
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.5;
  try {
    const model = createAvatarModel(scene, options.character, resolveAvatarColor(options.color));
    animateAvatar(model, options.state, 0, 1);
    return model;
  } catch (error) {
    disposeAvatarScene(scene);
    releaseShared();
    throw error;
  }
}

function setCamera(entry: Entry): void {
  const headOnly = entry.options.view === 'head';
  entry.camera.layers.set(headOnly ? 1 : 0);
  entry.camera.position.set(0.12, headOnly ? 2.65 : 2.85, headOnly ? 6.4 : 9.1);
  entry.camera.lookAt(0, headOnly ? 2.5 : 1.65, 0);
}

export function mountAvatar(
  canvas: HTMLCanvasElement,
  options: AvatarOptions,
  ready: () => void,
  fail: (error: Error) => void,
): AvatarHandle {
  validateAvatarOptions(options);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the avatar display.');
  const entry: Entry = {
    canvas,
    context,
    model: makeModel(options),
    camera: new THREE.PerspectiveCamera(31, 1, 0.1, 50),
    options,
    time: 0,
    lastTime: undefined,
    visible: true,
    dirty: true,
    failed: false,
    ready,
    fail,
  };
  setCamera(entry);
  entries.add(entry);
  const intersection = new IntersectionObserver(([result]) => {
    if (!result) return;
    entry.visible = result.isIntersecting;
    entry.lastTime = undefined;
    schedule();
  });
  intersection.observe(canvas);
  const resize = new ResizeObserver(() => {
    entry.dirty = true;
    schedule();
  });
  resize.observe(canvas);
  schedule();
  let disposed = false;
  return {
    update(next) {
      if (disposed) return;
      try {
        validateAvatarOptions(next);
        if (entry.options.character !== next.character) {
          const replacement = makeModel(next);
          disposeAvatarScene(entry.model.scene);
          entry.model = replacement;
          entry.time = 0;
        } else {
          entry.model.material.color.set(resolveAvatarColor(next.color));
          if (entry.options.state !== next.state) {
            entry.time = 0;
            animateAvatar(entry.model, next.state, 0, 1);
          }
        }
        entry.options = next;
        entry.lastTime = undefined;
        entry.dirty = true;
        entry.failed = false;
        setCamera(entry);
        schedule();
      } catch (error) {
        report(entry, error);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      intersection.disconnect();
      resize.disconnect();
      entries.delete(entry);
      disposeAvatarScene(entry.model.scene);
      releaseShared();
    },
  };
}
