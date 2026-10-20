import { createHash } from 'node:crypto';

// Deterministic UUIDs keep reruns idempotent: the same seed key always names the same entity.
export function stableId(...parts: readonly (string | number)[]) {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function stableRevision(...parts: readonly (string | number)[]) {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex');
}

export type Random = {
  next: () => number;
  int: (min: number, max: number) => number;
  pick: <T>(items: readonly T[]) => T;
  chance: (probability: number) => boolean;
};

// mulberry32: small, fast, and reproducible across Node versions.
export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: items => items[Math.floor(next() * items.length)]!,
    chance: probability => next() < probability,
  };
}

export const firstNames = [
  'Ava',
  'Ben',
  'Chloe',
  'Diego',
  'Elena',
  'Farah',
  'Gus',
  'Hana',
  'Ivan',
  'Jade',
  'Kofi',
  'Lena',
  'Mateo',
  'Nora',
  'Omar',
  'Priya',
  'Quinn',
  'Rosa',
  'Sam',
  'Tara',
];
export const lastNames = [
  'Adams',
  'Bose',
  'Chen',
  'Diaz',
  'Evans',
  'Fischer',
  'Garcia',
  'Hughes',
  'Ito',
  'Jones',
  'Kim',
  'Lopez',
  'Moreau',
  'Nakamura',
  'Okafor',
  'Patel',
];
export const companies = [
  'Acme Florals',
  'Bloom & Co',
  'Canal Street Bakery',
  'Delta Logistics',
  'Evergreen Farms',
  'Fjord Outfitters',
  'Granite Studio',
  'Harbor Coffee',
  'Iris Analytics',
  'Juniper Health',
];
export const cities = [
  'Amsterdam',
  'Austin',
  'Bengaluru',
  'Berlin',
  'Lagos',
  'Lisbon',
  'Melbourne',
  'Montreal',
  'Osaka',
  'Seattle',
];
export const topics = [
  'Q3 planning',
  'supplier onboarding',
  'invoice follow-up',
  'hiring pipeline',
  'customer renewal',
  'shipping delay',
  'weekly report',
  'pricing update',
  'event logistics',
  'inventory count',
];
