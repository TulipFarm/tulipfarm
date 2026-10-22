// Frozen order: any edit, even appending, changes existing agent avatars.
const objects = [
  'tulip',
  'tulip-bouquet',
  'cactus',
  'sunflower',
  'daisy',
  'sprout',
  'bonsai',
  'monstera',
  'fern',
  'lavender',
  'rose',
  'poppy',
  'daffodil',
  'lily',
  'bellflower',
  'eucalyptus',
  'ivy',
  'succulent',
  'acorn',
  'pinecone',
  'watering-can',
  'hand-trowel',
  'garden-fork',
  'pruning-shears',
  'gardening-gloves',
  'rain-boots',
  'wheelbarrow',
  'seed-packet',
  'flower-pot',
  'plant-mister',
  'spade',
  'rake',
  'hoe',
  'garden-hose',
  'seed-tray',
  'garden-apron',
  'plant-label',
  'twine-spool',
  'compost-bin',
  'pruning-saw',
  'mushroom',
  'strawberry',
  'carrot',
  'pumpkin',
  'apple',
  'pear',
  'lemon',
  'corn-cob',
  'honey-jar',
  'harvest-basket',
  'windmill',
  'barn',
  'tractor',
  'wheat',
  'pea-pod',
  'beetroot',
  'radish',
  'eggplant',
  'cherries',
  'hay-bale',
  'umbrella',
  'mug',
  'teapot',
  'moka-pot',
  'lantern',
  'candle',
  'picnic-basket',
  'straw-hat',
  'vase',
  'jam-jar',
  'birdhouse',
  'rocking-chair',
  'kettle',
  'bread-loaf',
  'croissant',
  'milk-bottle',
  'cookie',
  'oven-mitt',
  'thermos',
  'yarn-ball',
  'notebook',
  'pencil',
  'paintbrush',
  'paint-palette',
  'fountain-pen',
  'camera',
  'headphones',
  'desk-lamp',
  'book-stack',
  'alarm-clock',
  'scissors',
  'ruler',
  'stapler',
  'paperclip',
  'binder-clip',
  'tape-dispenser',
  'magnifying-glass',
  'envelope',
  'typewriter',
  'globe',
] as const;

const colors = ['pink', 'coral', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple'] as const;

// FNV-1a: small, stable, and spreads similar ids apart.
export function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Unset leaves agents on their initial-letter avatar instead of loading artwork.
const configuredAvatarOrigin: string | undefined = import.meta.env?.VITE_AGENT_AVATAR_URL;

export function agentAvatar(agentId: string, avatarOrigin = configuredAvatarOrigin) {
  const h = hash(agentId);
  const object = objects[h % objects.length];
  const color = colors[(h >>> 16) % colors.length];
  return { object, color, src: avatarOrigin ? `${avatarOrigin.replace(/\/$/, '')}/avatar/${object}/${color}.svg` : '' };
}
