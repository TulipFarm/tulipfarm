export type RgbaImage = { width: number; height: number; rgba: Uint8Array };

const compression = { rgb: 0, bitfields: 3, alphaBitfields: 6 };

// Prebuilt sharp has no BMP loader, so uncompressed BMPs are decoded here and passed to sharp as raw RGBA.
export function decodeBmp(bytes: Uint8Array, checkPixels: (width: number, height: number) => void): RgbaImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixelOffset = view.getUint32(10, true);
  const headerSize = view.getUint32(14, true);
  const core = headerSize === 12;
  const width = core ? view.getUint16(18, true) : view.getInt32(18, true);
  const signedHeight = core ? view.getUint16(20, true) : view.getInt32(22, true);
  const bitsPerPixel = view.getUint16(core ? 24 : 28, true);
  const method = core ? compression.rgb : view.getUint32(30, true);
  const height = Math.abs(signedHeight);
  if (width <= 0 || height === 0) throw new Error('BMP has no pixels');
  checkPixels(width, height);
  if (![compression.rgb, compression.bitfields, compression.alphaBitfields].includes(method)) {
    throw new Error(`BMP compression ${method} is not supported`);
  }

  const masks = channelMasks(view, headerSize, bitsPerPixel, method);
  const paletteOffset = 14 + headerSize + (headerSize === 40 ? { 0: 0, 3: 12, 6: 16 }[method]! : 0);
  const paletteEntrySize = core ? 3 : 4;
  const stride = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
  if (pixelOffset + stride * height > bytes.length) throw new Error('BMP pixel data is truncated');

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = pixelOffset + stride * (signedHeight > 0 ? height - 1 - y : y);
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (bitsPerPixel <= 8) {
        const bit = x * bitsPerPixel;
        const index = (bytes[row + (bit >> 3)]! >> (8 - bitsPerPixel - (bit & 7))) & ((1 << bitsPerPixel) - 1);
        const entry = paletteOffset + index * paletteEntrySize;
        if (entry + 3 > pixelOffset) throw new Error('BMP palette index is out of range');
        put(rgba, out, bytes[entry + 2]!, bytes[entry + 1]!, bytes[entry]!, 255);
      } else if (bitsPerPixel === 24) {
        const pixel = row + x * 3;
        put(rgba, out, bytes[pixel + 2]!, bytes[pixel + 1]!, bytes[pixel]!, 255);
      } else if (masks) {
        const offset = row + (x * bitsPerPixel) / 8;
        const pixel = bitsPerPixel === 16 ? view.getUint16(offset, true) : view.getUint32(offset, true);
        const [red, green, blue, alpha] = masks;
        put(rgba, out, scale(pixel, red), scale(pixel, green), scale(pixel, blue), alpha ? scale(pixel, alpha) : 255);
      } else {
        throw new Error(`BMP with ${bitsPerPixel} bits per pixel is not supported`);
      }
    }
  }
  return { width, height, rgba };
}

type Masks = [red: number, green: number, blue: number, alpha: number];

function channelMasks(view: DataView, headerSize: number, bitsPerPixel: number, method: number): Masks | undefined {
  if (bitsPerPixel !== 16 && bitsPerPixel !== 32) return undefined;
  if (method === compression.rgb) {
    return bitsPerPixel === 16 ? [0x7c00, 0x03e0, 0x001f, 0] : [0xff0000, 0x00ff00, 0x0000ff, 0];
  }
  const hasAlphaMask = method === compression.alphaBitfields || headerSize >= 56;
  return [
    view.getUint32(54, true),
    view.getUint32(58, true),
    view.getUint32(62, true),
    hasAlphaMask ? view.getUint32(66, true) : 0,
  ];
}

function put(rgba: Uint8Array, offset: number, red: number, green: number, blue: number, alpha: number): void {
  rgba[offset] = red;
  rgba[offset + 1] = green;
  rgba[offset + 2] = blue;
  rgba[offset + 3] = alpha;
}

function scale(pixel: number, mask: number): number {
  if (mask === 0) return 0;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  const max = mask >>> shift;
  return Math.round((((pixel & mask) >>> shift) * 255) / max);
}
