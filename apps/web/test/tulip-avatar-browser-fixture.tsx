import '../src/index.css';
import React from 'react';
export { React };
export { createRoot } from 'react-dom/client';
export {
  TulipAvatar,
  tulipAvatarCharacters,
  tulipAvatarColors,
  tulipAvatarStates,
} from '../src/components/tulip-avatar';
export { createAvatarModel, animateAvatar } from '../src/components/tulip-avatar/model';
export { disposeAvatarScene } from '../src/components/tulip-avatar/runtime';
export * as THREE from 'three';
