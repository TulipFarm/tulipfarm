/** The shapes an image model is asked for. Each catalog image model maps every shape to its own size or ratio. */
export const imageShapes = Object.freeze(['square', 'portrait', 'landscape'] as const);
export type ImageShape = (typeof imageShapes)[number];

/**
 * Named destinations an image can be made for, with the ratio the destination shows and the model shape nearest to
 * it. Social publishing reuses this table, so a preset name means the same thing everywhere.
 */
export const imagePresets = Object.freeze({
  'instagram-feed': { ratio: '4:5', shape: 'portrait' },
  'instagram-square': { ratio: '1:1', shape: 'square' },
  'instagram-story': { ratio: '9:16', shape: 'portrait' },
  'facebook-post': { ratio: '1.91:1', shape: 'landscape' },
  'linkedin-post': { ratio: '1.91:1', shape: 'landscape' },
  'x-post': { ratio: '16:9', shape: 'landscape' },
  'youtube-thumbnail': { ratio: '16:9', shape: 'landscape' },
  'presentation-slide': { ratio: '16:9', shape: 'landscape' },
} as const satisfies Record<string, { ratio: string; shape: ImageShape }>);
export type ImagePreset = keyof typeof imagePresets;
export const imagePresetNames = Object.freeze(Object.keys(imagePresets) as ImagePreset[]);
