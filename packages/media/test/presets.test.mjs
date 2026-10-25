import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { channelImageProblems, channelImageRules, imageChannels, imageDimensions, imagePresets } from '../src/index.ts';

/** The pixel size of an image drawn at a `W:H` ratio, 1080 pixels on its short edge. */
const atRatio = ratio => {
  const [w, h] = ratio.split(':').map(Number);
  return w >= h
    ? { width: Math.round((1080 * w) / h), height: 1080 }
    : { width: 1080, height: Math.round((1080 * h) / w) };
};

test('every social channel has a preset whose image passes its own rules', () => {
  for (const channel of imageChannels) {
    const rule = channelImageRules[channel];
    const preset = imagePresets[rule.preset];
    assert.ok(preset, `${channel} names a preset`);
    for (const mediaType of rule.mediaTypes)
      assert.deepEqual(
        channelImageProblems(channel, { mediaType, size: rule.maxBytes, ...atRatio(preset.ratio) }),
        [],
        `${channel} accepts a ${mediaType} at ${preset.ratio}`,
      );
  }
});

test('an image outside a channel’s rules says which rule it breaks', () => {
  const portrait = { width: 1024, height: 1536 };
  assert.deepEqual(channelImageProblems('instagram', { mediaType: 'image/png', size: 1_000, ...portrait }), [
    'image-type',
    'image-aspect-ratio',
  ]);
  assert.deepEqual(channelImageProblems('x', { mediaType: 'image/png', size: 5_000_001, width: 1, height: 1 }), [
    'image-too-large',
  ]);
  // Social checks Files it has no dimensions for, so the ratio is checked only when they are known.
  assert.deepEqual(channelImageProblems('instagram', { mediaType: 'image/jpeg', size: 1_000 }), []);
  // The edges of a range are allowed, with rounding: Instagram takes 1080x1350 and 1080x566.
  assert.deepEqual(
    channelImageProblems('instagram', { mediaType: 'image/jpeg', size: 1, width: 1080, height: 1350 }),
    [],
  );
  assert.deepEqual(
    channelImageProblems('instagram', { mediaType: 'image/jpeg', size: 1, width: 1080, height: 566 }),
    [],
  );
});

test('reads the displayed size of an image', async () => {
  const bytes = await sharp({ create: { width: 6, height: 4, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
  assert.deepEqual(await imageDimensions(bytes), { width: 6, height: 4 });
  assert.equal(await imageDimensions(new Uint8Array([1, 2, 3])), null);
});
