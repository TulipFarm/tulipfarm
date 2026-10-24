import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { bigEndianTiff, bmp24, bmp8Palette } from './encoders.mjs';
import { ImagePreparationError, modelImageMediaTypes, prepareImageForModel, sniffMediaType } from '../src/index.ts';

const fixture = name => readFile(new URL(`fixtures/${name}`, import.meta.url));
const generous = { maxBytes: 10_000_000 };

const solid = (width, height, background, channels = 3) => sharp({ create: { width, height, channels, background } });
const noise = (width, height, channels = 3) =>
  sharp({
    create: { width, height, channels, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 80 } },
  });

async function describe(prepared) {
  const { data, info } = await sharp(prepared.data).raw().toBuffer({ resolveWithObject: true });
  return {
    mediaType: prepared.mediaType,
    sniffed: sniffMediaType(prepared.data)?.mediaType,
    width: prepared.width,
    height: prepared.height,
    decodedWidth: info.width,
    decodedHeight: info.height,
    downscaled: prepared.downscaled,
    firstPixel: [...data.subarray(0, info.channels)],
  };
}

async function prepareUnchanged(input, options) {
  const before = new Uint8Array(input);
  const prepared = await prepareImageForModel(input, options);
  assert.deepEqual(new Uint8Array(input), before);
  return prepared;
}

function pngDeclaring(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(16))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function rejection(promise) {
  const error = await promise.then(
    () => assert.fail('expected the preparation to fail'),
    caught => caught,
  );
  assert.ok(error instanceof ImagePreparationError);
  return error.code;
}

test('lists the media types a model accepts', () => {
  assert.deepEqual(modelImageMediaTypes, ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
});

test('returns a model-ready image as an unchanged copy', async () => {
  for (const [input, mediaType] of [
    [await solid(64, 32, '#336699').png().toBuffer(), 'image/png'],
    [await solid(64, 32, '#336699').jpeg().toBuffer(), 'image/jpeg'],
    [await solid(64, 32, '#336699').webp().toBuffer(), 'image/webp'],
    [await solid(64, 32, '#336699').gif().toBuffer(), 'image/gif'],
  ]) {
    const prepared = await prepareUnchanged(input, generous);
    assert.deepEqual(prepared, { mediaType, data: new Uint8Array(input), width: 64, height: 32, downscaled: false });
    assert.notEqual(prepared.data.buffer, input.buffer);
  }
});

test('downscales to the longest-edge limit keeping the aspect ratio', async () => {
  const prepared = await prepareUnchanged(await solid(4000, 1000, '#336699').png().toBuffer(), {
    maxBytes: 10_000_000,
    maxEdge: 2048,
  });
  assert.deepEqual(await describe(prepared), {
    mediaType: 'image/png',
    sniffed: 'image/png',
    width: 2048,
    height: 512,
    decodedWidth: 2048,
    decodedHeight: 512,
    downscaled: true,
    firstPixel: [51, 102, 153],
  });
});

test('uses a 2048 pixel longest edge by default and never enlarges', async () => {
  const tall = await prepareUnchanged(await solid(1000, 3000, '#336699').jpeg().toBuffer(), generous);
  assert.deepEqual([tall.mediaType, tall.width, tall.height, tall.downscaled], ['image/jpeg', 683, 2048, true]);
  const small = await prepareUnchanged(await solid(10, 5, '#336699').png().toBuffer(), {
    maxBytes: 10_000,
    maxEdge: 4096,
  });
  assert.deepEqual([small.width, small.height, small.downscaled], [10, 5, false]);
});

test('keeps JPEG and WebP as their own type when resizing', async () => {
  const jpeg = await prepareUnchanged(await solid(3000, 1500, '#336699').jpeg().toBuffer(), generous);
  assert.deepEqual(
    [jpeg.mediaType, sniffMediaType(jpeg.data)?.mediaType, jpeg.width, jpeg.height],
    ['image/jpeg', 'image/jpeg', 2048, 1024],
  );
  const webp = await prepareUnchanged(await solid(3000, 1500, '#336699').webp().toBuffer(), generous);
  assert.deepEqual(
    [webp.mediaType, sniffMediaType(webp.data)?.mediaType, webp.width, webp.height],
    ['image/webp', 'image/webp', 2048, 1024],
  );
});

test('shrinks a noisy photo into the byte budget as JPEG', async () => {
  const input = await noise(1200, 800).png().toBuffer();
  assert.ok(input.byteLength > 1_000_000);
  const prepared = await prepareUnchanged(input, { maxBytes: 50_000 });
  assert.equal(prepared.mediaType, 'image/jpeg');
  assert.equal(sniffMediaType(prepared.data)?.mediaType, 'image/jpeg');
  assert.ok(prepared.data.byteLength <= 50_000);
  assert.equal(prepared.downscaled, true);
  assert.ok(Math.abs(prepared.width / prepared.height - 1.5) < 0.01);
});

test('keeps a noisy image with transparency as PNG within the byte budget', async () => {
  const prepared = await prepareUnchanged(await noise(600, 600, 4).png().toBuffer(), { maxBytes: 40_000 });
  assert.equal(prepared.mediaType, 'image/png');
  assert.ok(prepared.data.byteLength <= 40_000);
  assert.equal(prepared.width, prepared.height);
  assert.equal(prepared.downscaled, true);
});

test('converts HEIC to PNG at its original size', async () => {
  const prepared = await prepareUnchanged(await fixture('tiny.heic'), generous);
  const described = await describe(prepared);
  assert.deepEqual(
    { ...described, firstPixel: undefined },
    {
      mediaType: 'image/png',
      sniffed: 'image/png',
      width: 40,
      height: 30,
      decodedWidth: 40,
      decodedHeight: 30,
      downscaled: false,
      firstPixel: undefined,
    },
  );
  const expected = [200, 30, 60];
  described.firstPixel.forEach((channel, index) =>
    assert.ok(Math.abs(channel - expected[index]) <= 3, `${described.firstPixel}`),
  );
});

test('converts AVIF to PNG at its original size', async () => {
  const prepared = await prepareUnchanged(await solid(30, 20, '#336699').avif().toBuffer(), generous);
  const described = await describe(prepared);
  assert.deepEqual(
    { ...described, firstPixel: undefined },
    {
      mediaType: 'image/png',
      sniffed: 'image/png',
      width: 30,
      height: 20,
      decodedWidth: 30,
      decodedHeight: 20,
      downscaled: false,
      firstPixel: undefined,
    },
  );
  const expected = [51, 102, 153];
  described.firstPixel.forEach((channel, index) =>
    assert.ok(Math.abs(channel - expected[index]) <= 3, `${described.firstPixel}`),
  );
});

test('converts an animated GIF to a PNG of its first frame', async () => {
  const input = await fixture('animated.gif');
  assert.equal((await sharp(input, { animated: true }).metadata()).pages, 2);
  assert.deepEqual(await describe(await prepareUnchanged(input, generous)), {
    mediaType: 'image/png',
    sniffed: 'image/png',
    width: 12,
    height: 8,
    decodedWidth: 12,
    decodedHeight: 8,
    downscaled: false,
    firstPixel: [255, 0, 0, 255],
  });
});

test('converts TIFF and BMP to PNG', async () => {
  const cases = [
    [await solid(30, 20, '#336699').tiff({ compression: 'lzw' }).toBuffer(), 30, 20, [51, 102, 153]],
    [bigEndianTiff(30, 20, [51, 102, 153]), 30, 20, [51, 102, 153]],
    [bmp24(5, 3, [51, 102, 153]), 5, 3, [51, 102, 153]],
    [
      bmp8Palette(
        3,
        2,
        [
          [255, 0, 0],
          [0, 0, 255],
        ],
        [
          [0, 1, 1],
          [1, 1, 1],
        ],
      ),
      3,
      2,
      [255, 0, 0],
    ],
  ];
  for (const [input, width, height, firstPixel] of cases) {
    assert.deepEqual(await describe(await prepareUnchanged(input, generous)), {
      mediaType: 'image/png',
      sniffed: 'image/png',
      width,
      height,
      decodedWidth: width,
      decodedHeight: height,
      downscaled: false,
      firstPixel,
    });
  }
});

test('downscales an image that needs conversion as well', async () => {
  const prepared = await prepareUnchanged(bmp24(300, 100, [51, 102, 153]), { maxBytes: 10_000_000, maxEdge: 150 });
  assert.deepEqual(
    [prepared.mediaType, prepared.width, prepared.height, prepared.downscaled],
    ['image/png', 150, 50, true],
  );
});

test('renders SVG without running scripts or fetching external references', async t => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'image/png' }).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const svg = Buffer.from((await fixture('hostile.svg')).toString('utf8').replaceAll('PORT', String(port)));

  const prepared = await prepareUnchanged(svg, generous);
  await new Promise(resolve => setTimeout(resolve, 200));

  assert.deepEqual(requests, []);
  assert.deepEqual(await describe(prepared), {
    mediaType: 'image/png',
    sniffed: 'image/png',
    width: 120,
    height: 80,
    decodedWidth: 120,
    decodedHeight: 80,
    downscaled: false,
    firstPixel: [0, 255, 0, 255],
  });
});

test('applies EXIF orientation before sizing', async () => {
  const input = await solid(40, 20, '#336699').jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const prepared = await prepareUnchanged(input, generous);
  assert.deepEqual(
    [prepared.mediaType, prepared.width, prepared.height, prepared.downscaled],
    ['image/jpeg', 20, 40, false],
  );
  const metadata = await sharp(prepared.data).metadata();
  assert.deepEqual([metadata.width, metadata.height, metadata.orientation], [20, 40, undefined]);
});

test('rejects images above 100 megapixels', async () => {
  assert.equal(await rejection(prepareImageForModel(pngDeclaring(20_000, 20_000), generous)), 'too-many-pixels');
  const hugeBmp = bmp24(1, 1, [0, 0, 0]);
  hugeBmp.writeInt32LE(20_000, 18);
  hugeBmp.writeInt32LE(20_000, 22);
  assert.equal(await rejection(prepareImageForModel(hugeBmp, generous)), 'too-many-pixels');
});

test('rejects bytes that are not a supported image', async () => {
  assert.equal(await rejection(prepareImageForModel(Buffer.from('%PDF-1.7\n%%EOF\n'), generous)), 'unsupported-type');
  assert.equal(await rejection(prepareImageForModel(Buffer.from('plain text'), generous)), 'unsupported-type');
});

test('reports a corrupt image as a decode failure', async () => {
  const truncated = (await solid(64, 64, '#336699').png().toBuffer()).subarray(0, 40);
  assert.equal(await rejection(prepareImageForModel(truncated, generous)), 'decode-failed');
});

test('reports an image that cannot fit the byte budget at any size', async () => {
  assert.equal(
    await rejection(prepareImageForModel(await solid(64, 64, '#336699').png().toBuffer(), { maxBytes: 10 })),
    'over-budget',
  );
});
