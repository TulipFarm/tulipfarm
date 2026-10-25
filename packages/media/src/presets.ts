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
  'threads-post': { ratio: '4:5', shape: 'portrait' },
  'pinterest-pin': { ratio: '2:3', shape: 'portrait' },
  'tiktok-photo': { ratio: '9:16', shape: 'portrait' },
  'reddit-post': { ratio: '1:1', shape: 'square' },
  'youtube-thumbnail': { ratio: '16:9', shape: 'landscape' },
  'presentation-slide': { ratio: '16:9', shape: 'landscape' },
} as const satisfies Record<string, { ratio: string; shape: ImageShape }>);
export type ImagePreset = keyof typeof imagePresets;
export const imagePresetNames = Object.freeze(Object.keys(imagePresets) as ImagePreset[]);

type ChannelImageRule = {
  /** The preset an image made for the channel uses unless an aspect or another preset is asked for. */
  preset: ImagePreset;
  /** The image types the platform's publishing API takes. GIFs are their own media kind in social posts. */
  mediaTypes: readonly string[];
  maxBytes: number;
  /** The narrowest and widest width-to-height ratio the platform publishes, when it has a limit. */
  ratio?: { min: string; max: string };
};

/**
 * What each social platform takes for an image in a post, keyed by the platform names social publishing uses. Images
 * generated for a channel and images attached to a post variant are checked against the same rule.
 */
export const channelImageRules = Object.freeze({
  linkedin: { preset: 'linkedin-post', mediaTypes: ['image/jpeg', 'image/png'], maxBytes: 10_000_000 },
  youtube: { preset: 'youtube-thumbnail', mediaTypes: ['image/jpeg', 'image/png'], maxBytes: 2_000_000 },
  facebook: {
    preset: 'facebook-post',
    mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/heif'],
    maxBytes: 4_000_000,
  },
  instagram: {
    // Every model's portrait (2:3 or 3:4) is narrower than Instagram's 4:5, so a feed image starts square.
    preset: 'instagram-square',
    mediaTypes: ['image/jpeg'],
    maxBytes: 8_000_000,
    ratio: { min: '4:5', max: '1.91:1' },
  },
  threads: {
    preset: 'threads-post',
    mediaTypes: ['image/jpeg', 'image/png'],
    maxBytes: 8_000_000,
    ratio: { min: '1:10', max: '10:1' },
  },
  pinterest: {
    preset: 'pinterest-pin',
    mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff'],
    maxBytes: 20_000_000,
  },
  tiktok: { preset: 'tiktok-photo', mediaTypes: ['image/jpeg', 'image/webp'], maxBytes: 20_000_000 },
  x: { preset: 'x-post', mediaTypes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5_000_000 },
  reddit: { preset: 'reddit-post', mediaTypes: ['image/jpeg', 'image/png'], maxBytes: 20_000_000 },
} as const satisfies Record<string, ChannelImageRule>);
export type ImageChannel = keyof typeof channelImageRules;
export const imageChannels = Object.freeze(Object.keys(channelImageRules) as ImageChannel[]);

export const channelImageProblemCodes = Object.freeze(['image-type', 'image-too-large', 'image-aspect-ratio'] as const);
export type ChannelImageProblem = (typeof channelImageProblemCodes)[number];

const ratioValue = (ratio: string) => {
  const [width, height] = ratio.split(':').map(Number);
  return width! / height!;
};
// Platforms round to whole pixels, so 1080x566 counts as 1.91:1.
const ratioTolerance = 0.005;

/** Why an image cannot go to `channel` as it is; empty when it can. The ratio is checked only with both dimensions. */
export function channelImageProblems(
  channel: ImageChannel,
  image: { mediaType: string; size: number; width?: number | undefined; height?: number | undefined },
): ChannelImageProblem[] {
  const rule: ChannelImageRule = channelImageRules[channel];
  const problems: ChannelImageProblem[] = [];
  if (!rule.mediaTypes.includes(image.mediaType.split(';')[0]!.trim().toLowerCase())) problems.push('image-type');
  if (image.size > rule.maxBytes) problems.push('image-too-large');
  if (rule.ratio && image.width && image.height) {
    const ratio = image.width / image.height;
    if (
      ratio < ratioValue(rule.ratio.min) * (1 - ratioTolerance) ||
      ratio > ratioValue(rule.ratio.max) * (1 + ratioTolerance)
    )
      problems.push('image-aspect-ratio');
  }
  return problems;
}
