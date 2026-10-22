export const tulipAvatarCharacters = [
  'Bud',
  'Bloom',
  'Swoop',
  'Pip',
  'Curl',
  'Fan',
  'Twin',
  'Fringe',
  'Dew',
  'Clover',
  'Ribbon',
  'Floret',
  'Wisp',
  'Bramble',
  'Lotus',
  'Sprig',
] as const;

export const tulipAvatarColors = {
  Blue: '#299fe9',
  Rose: '#ec749e',
  Sage: '#71b88c',
  Apricot: '#f3a055',
  Lilac: '#a28ade',
  Butter: '#e2c750',
  Coral: '#e96d58',
  Mint: '#69ccba',
  Periwinkle: '#788bdc',
  Peach: '#efb394',
  Plum: '#a069a3',
  Cloud: '#bdcad5',
} as const;

import { avatarStates } from '@tulipfarm/conversations/avatar';
export const tulipAvatarStates = avatarStates;

export type TulipAvatarCharacter = (typeof tulipAvatarCharacters)[number];
export type TulipAvatarColor = keyof typeof tulipAvatarColors | `#${string}`;
export type TulipAvatarState = (typeof tulipAvatarStates)[number];
export type TulipAvatarSize = 24 | 32 | 40 | 64 | 128 | 256;
export type TulipAvatarView = 'head' | 'full';

export interface AvatarOptions {
  character: TulipAvatarCharacter;
  color: TulipAvatarColor;
  state: TulipAvatarState;
  view: TulipAvatarView;
  paused: boolean;
}

export function resolveAvatarColor(color: TulipAvatarColor): string {
  if (Object.hasOwn(tulipAvatarColors, color)) {
    return tulipAvatarColors[color as keyof typeof tulipAvatarColors];
  }
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  throw new Error(`Invalid avatar color: ${color}. Use a named color or #RRGGBB.`);
}

export function validateAvatarOptions(options: AvatarOptions): void {
  if (!tulipAvatarCharacters.includes(options.character)) throw new Error('Unknown avatar character.');
  if (!tulipAvatarStates.includes(options.state)) throw new Error('Unknown avatar state.');
  if (options.view !== 'head' && options.view !== 'full') throw new Error('Unknown avatar view.');
  resolveAvatarColor(options.color);
}
